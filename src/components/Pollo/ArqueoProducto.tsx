import React, { useEffect, useMemo, useRef, useState } from "react";
import ActionMenu from "../common/ActionMenu";
import {
  addDoc,
  collection,
  getDocs,
  getDoc,
  deleteDoc,
  doc,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { format } from "date-fns";
import * as XLSX from "xlsx";
import { db, auth } from "../../firebase";
import RefreshButton from "../common/RefreshButton";
import useManualRefresh from "../../hooks/useManualRefresh";

const today = () => format(new Date(), "yyyy-MM-dd");

const money = (n: unknown) => {
  const v = Number(n ?? 0) || 0;
  return `C$${v.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const qty3 = (n: unknown) => Number(n ?? 0).toFixed(3);
const round2 = (n: unknown) => Math.round((Number(n ?? 0) || 0) * 100) / 100;
const round3 = (n: unknown) => Math.round((Number(n ?? 0) || 0) * 1000) / 1000;

type InventoryBatchDoc = {
  batchGroupId?: string;
  category?: string;
  createdAt?: string;
  date?: string;
  expectedTotal?: number;
  invoiceTotal?: number;
  notes?: string;
  orderName?: string;
  productId?: string;
  productName?: string;
  purchasePrice?: number;
  quantity?: number;
  remaining?: number;
  salePrice?: number;
  status?: string;
  unit?: string;
};

type AuditRow = {
  productId: string;
  productName: string;
  salePrice: number;
  costPrice: number;
  theoreticalLbs: number;
  theoreticalAmount: number;
  realLbs: number | "";
  realAmount: number;
  differenceLbs: number;
  differenceAmount: number;
  observation: string;
  batchCount: number;
};

type AuditSummary = {
  totalTheoreticalLbs: number;
  totalTheoreticalAmount: number;
  totalRealLbs: number;
  totalRealAmount: number;
  totalDifferenceLbs: number;
  totalDifferenceAmount: number;
};

type SavedAudit = {
  id: string;
  from: string;
  to: string;
  status?: string;
  createdAt?: any;
  updatedAt?: any;
  createdBy?: {
    uid?: string | null;
    email?: string | null;
    name?: string | null;
    displayName?: string | null;
  } | null;
  summary?: AuditSummary;
  generalObservation?: string | null;
  rows?: Array<{
    productId: string;
    productName: string;
    salePrice: number;
    costPrice: number;
    theoreticalLbs: number;
    theoreticalAmount: number;
    realLbs: number | null;
    realAmount: number;
    differenceLbs: number;
    differenceAmount: number;
    observation?: string | null;
    batchCount?: number;
  }>;
};

function isLbUnit(unit: unknown): boolean {
  const s = String(unit || "")
    .toLowerCase()
    .trim();
  return ["lb", "lbs", "libra", "libras"].includes(s);
}

function safeProductName(b: InventoryBatchDoc) {
  return String(b.productName || "").trim() || "SIN NOMBRE";
}

function safeProductId(b: InventoryBatchDoc) {
  return String(b.productId || "").trim();
}

function getBatchSalePrice(b: InventoryBatchDoc): number {
  const direct = Number(b.salePrice || 0);
  if (direct > 0) return direct;

  const expected = Number(b.expectedTotal || 0);
  const qty = Number(b.quantity || 0);
  if (expected > 0 && qty > 0) return expected / qty;

  return 0;
}

function getBatchCostPrice(b: InventoryBatchDoc): number {
  return Number(b.purchasePrice || 0) || 0;
}

function calcRow(
  base: Omit<
    AuditRow,
    "theoreticalAmount" | "realAmount" | "differenceLbs" | "differenceAmount"
  >,
): AuditRow {
  const theoreticalLbs = round3(base.theoreticalLbs);
  const salePrice = round2(base.salePrice);
  const realLbsNum =
    base.realLbs === "" ? 0 : round3(Number(base.realLbs || 0) || 0);

  const theoreticalAmount = round2(theoreticalLbs * salePrice);
  const realAmount = round2(realLbsNum * salePrice);
  const differenceLbs = round3(realLbsNum - theoreticalLbs);
  const differenceAmount = round2(differenceLbs * salePrice);

  return {
    ...base,
    salePrice,
    theoreticalLbs,
    theoreticalAmount,
    realLbs: base.realLbs === "" ? "" : realLbsNum,
    realAmount,
    differenceLbs,
    differenceAmount,
  };
}

function getCreatedByLabel(a: SavedAudit) {
  const email = a.createdBy?.email || "";
  const name = a.createdBy?.name || a.createdBy?.displayName || "";
  if (name) return name;
  const uid = a.createdBy?.uid || "";
  return uid || "—";
}

function diffClass(n: number) {
  if (n < 0) return "text-red-700 font-semibold";
  if (n > 0) return "text-green-700 font-semibold";
  return "text-gray-800";
}

export default function ArqueoProducto(): React.ReactElement {
  const [openMenu, setOpenMenu] = useState<{
    id: string | null;
    rect: DOMRect | null;
  }>({ id: null, rect: null });
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const handleDeleteAudit = async (auditId: string) => {
    if (!window.confirm("¿Seguro que deseas eliminar este arqueo?")) return;
    try {
      await deleteDoc(doc(db, "inventory_audits_pollo", auditId));
      window.alert("Arqueo eliminado correctamente.");
      refresh();
    } catch (e) {
      window.alert("No se pudo eliminar el arqueo. Revisa la consola.");
      console.error("Error eliminando arqueo:", e);
    }
  };
  const { refreshKey, refresh } = useManualRefresh();

  const [loadingList, setLoadingList] = useState(true);
  const [audits, setAudits] = useState<SavedAudit[]>([]);

  const [fromFilter, setFromFilter] = useState(today());
  const [toFilter, setToFilter] = useState(today());

  const [createOpen, setCreateOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedAudit, setSelectedAudit] = useState<SavedAudit | null>(null);
  const [editRows, setEditRows] = useState<SavedAudit["rows"]>([]);
  const [editGeneralObservation, setEditGeneralObservation] =
    useState<string>("");
  const [editSaving, setEditSaving] = useState(false);

  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [generalObservation, setGeneralObservation] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [productFilter, setProductFilter] = useState("");
  const [diffFilter, setDiffFilter] = useState<
    "ALL" | "WITH_DIFF" | "MATCHED" | "MISSING_REAL"
  >("ALL");

  const createModalRef = useRef<HTMLDivElement | null>(null);
  const detailModalRef = useRef<HTMLDivElement | null>(null);
  const editModalRef = useRef<HTMLDivElement | null>(null);

  const resetCreateForm = () => {
    setFrom(today());
    setTo(today());
    setRows([]);
    setGeneralObservation("");
    setLoaded(false);
    setProductFilter("");
    setDiffFilter("ALL");
  };

  // Basic placeholders to satisfy references and keep TS happy.
  const loadRows = async () => {
    setLoadingProducts(true);
    try {
      // TODO: implement actual product loading logic
      setRows([]);
      setLoaded(true);
    } catch (err) {
      console.error("Error cargando productos:", err);
      setRows([]);
      setLoaded(false);
    } finally {
      setLoadingProducts(false);
    }
  };

  const updateRealLbs = (productId: string, value: string) => {
    setRows((prev: AuditRow[] = []) =>
      prev.map((r: AuditRow) => {
        if (r.productId !== productId) return r;
        const normalized = value.replace(/,/g, ".").trim();
        if (normalized === "") return calcRow({ ...r, realLbs: "" });
        if (!/^\d*(\.\d{0,3})?$/.test(normalized)) return r;
        const num = Number(normalized);
        if (!Number.isFinite(num) || num < 0) return r;
        return calcRow({ ...r, realLbs: num });
      }),
    );
  };

  const updateObservation = (productId: string, value: string) => {
    setRows((prev: AuditRow[] = []) =>
      prev.map((r) =>
        r.productId === productId ? { ...r, observation: value } : r,
      ),
    );
  };

  const saveEditedAudit = async () => {
    if (!selectedAudit) return;
    setEditSaving(true);
    try {
      const docRef = doc(db, "inventory_audits_pollo", selectedAudit.id);
      const rowsToSave = (editRows || []).map((r) => ({
        productId: r.productId,
        productName: r.productName,
        salePrice: round2(r.salePrice),
        costPrice: round2(r.costPrice),
        theoreticalLbs: round3(r.theoreticalLbs),
        theoreticalAmount: round2(r.theoreticalAmount),
        realLbs: r.realLbs == null ? null : round3(r.realLbs),
        realAmount: round2(r.realAmount),
        differenceLbs: round3(r.differenceLbs),
        differenceAmount: round2(r.differenceAmount),
        observation: (r as any).observation || null,
        batchCount: (r as any).batchCount || 0,
      }));

      const summaryObj = {
        totalTheoreticalLbs: round3(editSummary.totalTheoreticalLbs),
        totalTheoreticalAmount: round2(editSummary.totalTheoreticalAmount),
        totalRealLbs: round3(editSummary.totalRealLbs),
        totalRealAmount: round2(editSummary.totalRealAmount),
        totalDifferenceLbs: round3(editSummary.totalDifferenceLbs),
        totalDifferenceAmount: round2(editSummary.totalDifferenceAmount),
      };

      await updateDoc(docRef, {
        rows: rowsToSave,
        summary: summaryObj,
        generalObservation: editGeneralObservation.trim() || null,
        updatedAt: serverTimestamp(),
      });

      setEditOpen(false);
      setSelectedAudit(null);
      refresh();
    } catch (err) {
      console.error("Error actualizando arqueo:", err);
      window.alert("No se pudo guardar la edición. Revisa la consola.");
    } finally {
      setEditSaving(false);
    }
  };

  const loadAuditList = async () => {
    setLoadingList(true);
    try {
      const qAud = query(
        collection(db, "inventory_audits_pollo"),
        orderBy("createdAt", "desc"),
      );
      const snap = await getDocs(qAud);

      const list: SavedAudit[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as any),
      }));

      // fill missing createdBy.name by reading `users` collection when possible
      const uids = Array.from(
        new Set(
          list
            .map((a) => a.createdBy?.uid)
            .filter((x): x is string => Boolean(x) && x !== ""),
        ),
      );

      if (uids.length) {
        const updated = [...list];
        await Promise.all(
          uids.map(async (uid) => {
            // check if any audit already has name; skip fetching if all have name
            const need = updated.some(
              (a) => a.createdBy?.uid === uid && !a.createdBy?.name,
            );
            if (!need) return;

            try {
              const userDoc = await getDoc(doc(db, "users", uid));
              if (!userDoc.exists()) return;
              const udata = userDoc.data() as any;
              const uname =
                udata?.name || udata?.displayName || udata?.email || null;
              if (!uname) return;

              for (let i = 0; i < updated.length; i++) {
                if (updated[i].createdBy?.uid === uid) {
                  updated[i] = {
                    ...updated[i],
                    createdBy: {
                      ...(updated[i].createdBy || {}),
                      name: updated[i].createdBy?.name || uname,
                    },
                  };
                }
              }
            } catch (err) {
              console.warn("No se pudo cargar user doc for uid", uid, err);
            }
          }),
        );

        setAudits(updated);
      } else {
        setAudits(list);
      }
    } catch (e) {
      console.error("Error cargando arqueos:", e);
      setAudits([]);
    } finally {
      setLoadingList(false);
    }
  };

  useEffect(() => {
    loadAuditList();
  }, [refreshKey]);

  useEffect(() => {
    if (editOpen && selectedAudit) {
      setEditRows((selectedAudit.rows || []).map((r) => ({ ...r })));
      setEditGeneralObservation(selectedAudit.generalObservation || "");
    } else {
      setEditRows([]);
      setEditGeneralObservation("");
    }
  }, [editOpen, selectedAudit]);

  useEffect(() => {
    const onMouseDown = (ev: MouseEvent) => {
      const target = ev.target as Node;

      if (createOpen) {
        if (
          createModalRef.current &&
          !createModalRef.current.contains(target)
        ) {
          setCreateOpen(false);
        }
      }

      if (detailOpen) {
        if (
          detailModalRef.current &&
          !detailModalRef.current.contains(target)
        ) {
          setDetailOpen(false);
          setSelectedAudit(null);
        }
      }

      if (editOpen) {
        if (editModalRef.current && !editModalRef.current.contains(target)) {
          setEditOpen(false);
          setSelectedAudit(null);
        }
      }
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setCreateOpen(false);
        setDetailOpen(false);
        setSelectedAudit(null);
        setEditOpen(false);
      }
    };

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [createOpen, detailOpen, editOpen]);

  useEffect(() => {
    if (!openMenu.id) return;

    const onDown = (ev: Event) => {
      const target = ev.target as Node;
      if (actionMenuRef.current && !actionMenuRef.current.contains(target)) {
        setOpenMenu({ id: null, rect: null });
      }
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpenMenu({ id: null, rect: null });
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("scroll", onDown, true);
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("scroll", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenu.id]);

  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
    <div>
      <label className="block text-sm text-gray-600 mb-1">Desde</label>
      <input
        type="date"
        className="border rounded px-3 py-2 w-full"
        value={fromFilter}
        onChange={(e) => setFromFilter(e.target.value)}
      />
    </div>

    <div>
      <label className="block text-sm text-gray-600 mb-1">Hasta</label>
      <input
        type="date"
        className="border rounded px-3 py-2 w-full"
        value={toFilter}
        onChange={(e) => setToFilter(e.target.value)}
      />
    </div>
  </div>;

  {
    /* modal editar arqueo */
  }
  {
    editOpen && selectedAudit && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4">
        <div className="absolute inset-0 bg-black/50" />

        <div
          ref={editModalRef}
          className="relative bg-white rounded-2xl shadow-2xl w-full max-w-[98vw] h-[96vh] overflow-hidden"
        >
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div>
              <h3 className="text-lg sm:text-xl font-bold">Editar Arqueo</h3>
              <div className="text-sm text-gray-500">
                {selectedAudit.from || "—"} → {selectedAudit.to || "—"}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={saveEditedAudit}
                className="px-3 py-2 rounded bg-blue-600 hover:bg-blue-700 text-white text-sm disabled:opacity-60"
                disabled={editSaving}
              >
                {editSaving ? "Guardando..." : "Guardar cambios"}
              </button>

              <button
                type="button"
                onClick={() => {
                  setEditOpen(false);
                  setSelectedAudit(null);
                }}
                className="px-3 py-2 border rounded text-sm"
              >
                Cerrar
              </button>
            </div>
          </div>

          <div className="h-[calc(96vh-65px)] overflow-y-auto p-4">
            <div className="mb-4">
              <label className="block text-sm text-gray-600 mb-1">
                Observación general
              </label>
              <textarea
                className="border rounded px-3 py-2 w-full min-h-[90px]"
                value={editGeneralObservation}
                onChange={(e) => setEditGeneralObservation(e.target.value)}
                placeholder="Notas generales del arqueo..."
              />
            </div>

            <div className="hidden md:block overflow-x-auto">
              <table className="min-w-full border text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="border p-2">Producto</th>
                    <th className="border p-2">Precio venta</th>
                    <th className="border p-2">Precio costo</th>
                    <th className="border p-2">Libras teóricas</th>
                    <th className="border p-2">Monto teórico</th>
                    <th className="border p-2">Libras reales</th>
                    <th className="border p-2">Monto real</th>
                    <th className="border p-2">Diferencia lb</th>
                    <th className="border p-2">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {(editRows || []).map((r: any) => (
                    <tr key={r.productId} className="text-center">
                      <td className="border p-1 text-left">
                        <div className="font-medium">{r.productName}</div>
                        <div className="text-[11px] text-gray-500">
                          {r.productId} • lotes: {r.batchCount}
                        </div>
                      </td>
                      <td className="border p-1">{money(r.salePrice)}</td>
                      <td className="border p-1">{money(r.costPrice)}</td>
                      <td className="border p-1">{qty3(r.theoreticalLbs)}</td>
                      <td className="border p-1">
                        {money(r.theoreticalAmount)}
                      </td>
                      <td className="border p-1">
                        <input
                          type="text"
                          inputMode="decimal"
                          className="border rounded px-2 py-1 w-28 text-right"
                          value={r.realLbs == null ? "" : String(r.realLbs)}
                          onChange={(e) =>
                            updateEditRealLbs(r.productId, e.target.value)
                          }
                          placeholder="0.000"
                        />
                      </td>
                      <td className="border p-1">{money(r.realAmount)}</td>
                      <td
                        className={`border p-1 ${diffClass(r.differenceLbs)}`}
                      >
                        {qty3(r.differenceLbs)}
                      </td>
                      <td className="border p-1">
                        <button
                          type="button"
                          className="px-2 py-1 text-sm border rounded text-red-600"
                          onClick={() => removeEditRow(r.productId)}
                        >
                          Eliminar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="md:hidden space-y-3">
              {(editRows || []).map((r: any) => (
                <div
                  key={r.productId}
                  className="border rounded-xl p-3 bg-white shadow-sm"
                >
                  <div className="flex justify-between items-start gap-2">
                    <div>
                      <div className="text-sm font-semibold">
                        {r.productName}
                      </div>
                      <div className="text-xs text-gray-500">
                        {r.productId} • lotes: {r.batchCount}
                      </div>
                    </div>

                    <div className="text-right">
                      <button
                        type="button"
                        className="px-2 py-1 text-sm border rounded text-red-600"
                        onClick={() => removeEditRow(r.productId)}
                      >
                        Eliminar
                      </button>
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <div className="border rounded p-2 bg-gray-50 col-span-2">
                      <div className="text-xs text-gray-500 mb-1">
                        Libras reales
                      </div>
                      <input
                        type="text"
                        inputMode="decimal"
                        className="border rounded px-3 py-2 w-full"
                        value={r.realLbs == null ? "" : String(r.realLbs)}
                        onChange={(e) =>
                          updateEditRealLbs(r.productId, e.target.value)
                        }
                        placeholder="0.000"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const summary: AuditSummary = useMemo(() => {
    return rows.reduce(
      (acc, r) => {
        const real = r.realLbs === "" ? 0 : Number(r.realLbs || 0);
        acc.totalTheoreticalLbs = round3(
          acc.totalTheoreticalLbs + Number(r.theoreticalLbs || 0),
        );
        acc.totalTheoreticalAmount = round2(
          acc.totalTheoreticalAmount + Number(r.theoreticalAmount || 0),
        );
        acc.totalRealLbs = round3(acc.totalRealLbs + real);
        acc.totalRealAmount = round2(
          acc.totalRealAmount + Number(r.realAmount || 0),
        );
        acc.totalDifferenceLbs = round3(
          acc.totalDifferenceLbs + Number(r.differenceLbs || 0),
        );
        acc.totalDifferenceAmount = round2(
          acc.totalDifferenceAmount + Number(r.differenceAmount || 0),
        );
        return acc;
      },
      {
        totalTheoreticalLbs: 0,
        totalTheoreticalAmount: 0,
        totalRealLbs: 0,
        totalRealAmount: 0,
        totalDifferenceLbs: 0,
        totalDifferenceAmount: 0,
      } as AuditSummary,
    );
  }, [rows]);

  const editSummary: AuditSummary = useMemo(() => {
    const ers = editRows || [];
    return (ers as any).reduce(
      (acc: AuditSummary, r: any) => {
        const real =
          r.realLbs === "" || r.realLbs == null ? 0 : Number(r.realLbs || 0);
        acc.totalTheoreticalLbs = round3(
          acc.totalTheoreticalLbs + Number(r.theoreticalLbs || 0),
        );
        acc.totalTheoreticalAmount = round2(
          acc.totalTheoreticalAmount + Number(r.theoreticalAmount || 0),
        );
        acc.totalRealLbs = round3(acc.totalRealLbs + real);
        acc.totalRealAmount = round2(
          acc.totalRealAmount + Number(r.realAmount || 0),
        );
        acc.totalDifferenceLbs = round3(
          acc.totalDifferenceLbs + Number(r.differenceLbs || 0),
        );
        acc.totalDifferenceAmount = round2(
          acc.totalDifferenceAmount + Number(r.differenceAmount || 0),
        );
        return acc;
      },
      {
        totalTheoreticalLbs: 0,
        totalTheoreticalAmount: 0,
        totalRealLbs: 0,
        totalRealAmount: 0,
        totalDifferenceLbs: 0,
        totalDifferenceAmount: 0,
      } as AuditSummary,
    );
  }, [editRows]);

  const filteredRows = useMemo(() => {
    const term = productFilter.trim().toLowerCase();

    return rows.filter((r) => {
      const textOk =
        !term ||
        r.productName.toLowerCase().includes(term) ||
        r.productId.toLowerCase().includes(term);

      if (!textOk) return false;

      if (diffFilter === "WITH_DIFF") {
        return Number(r.differenceLbs || 0) !== 0;
      }
      if (diffFilter === "MATCHED") {
        return Number(r.differenceLbs || 0) === 0 && r.realLbs !== "";
      }
      if (diffFilter === "MISSING_REAL") {
        return r.realLbs === "";
      }
      return true;
    });
  }, [rows, productFilter, diffFilter]);

  const enteredCount = useMemo(
    () => rows.filter((r) => r.realLbs !== "").length,
    [rows],
  );

  const differencesCount = useMemo(
    () => rows.filter((r) => Number(r.differenceLbs || 0) !== 0).length,
    [rows],
  );

  const filteredAudits = useMemo(() => {
    return audits.filter((a) => {
      const date = a.to || a.from || "";
      if (fromFilter && date < fromFilter) return false;
      if (toFilter && date > toFilter) return false;
      return true;
    });
  }, [audits, fromFilter, toFilter]);

  const exportCreateExcel = () => {
    const wb = XLSX.utils.book_new();

    const summaryRows = [
      ["Fecha inicio", from],
      ["Fecha final", to],
      ["Total libras teóricas", round3(summary.totalTheoreticalLbs)],
      ["Total monto teórico", round2(summary.totalTheoreticalAmount)],
      ["Total libras reales", round3(summary.totalRealLbs)],
      ["Total monto real", round2(summary.totalRealAmount)],
      ["Total diferencia lb", round3(summary.totalDifferenceLbs)],
      ["Total monto diferencia", round2(summary.totalDifferenceAmount)],
      ["Productos auditados", rows.length],
      ["Productos con conteo real", enteredCount],
      ["Productos con diferencia", differencesCount],
      ["Observación general", generalObservation || ""],
    ];

    const detailRows = [
      [
        "Fecha inicio",
        "Fecha final",
        "Producto",
        "Product ID",
        "Precio venta",
        "Precio costo",
        "Libras teóricas",
        "Monto teórico",
        "Libras reales",
        "Monto real",
        "Diferencia lb",
        "Monto diferencia",
        "Lotes",
        "Observación",
      ],
      ...rows.map((r) => [
        from,
        to,
        r.productName,
        r.productId,
        round2(r.salePrice),
        round2(r.costPrice),
        round3(r.theoreticalLbs),
        round2(r.theoreticalAmount),
        r.realLbs === "" ? "" : round3(r.realLbs),
        round2(r.realAmount),
        round3(r.differenceLbs),
        round2(r.differenceAmount),
        r.batchCount,
        r.observation || "",
      ]),
    ];

    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet(summaryRows),
      "Resumen",
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet(detailRows),
      "Detalle",
    );
    XLSX.writeFile(wb, `arqueo_producto_${from}_${to}.xlsx`);
  };

  const saveAudit = async () => {
    if (!from || !to) {
      window.alert("Debes seleccionar fecha inicio y fecha final.");
      return;
    }

    if (from > to) {
      window.alert("La fecha inicio no puede ser mayor que la fecha final.");
      return;
    }

    if (!rows.length) {
      window.alert("No hay productos cargados para guardar.");
      return;
    }

    if (!rows.some((r) => r.realLbs !== "")) {
      window.alert("Debes ingresar al menos una libra real.");
      return;
    }

    setSaving(true);
    try {
      const user = auth.currentUser;

      const payload = {
        from,
        to,
        status: "completed",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        createdBy: user
          ? {
              uid: user.uid,
              email: user.email ?? null,
              name: (user as any).displayName ?? null,
            }
          : null,
        summary: {
          totalTheoreticalLbs: round3(summary.totalTheoreticalLbs),
          totalTheoreticalAmount: round2(summary.totalTheoreticalAmount),
          totalRealLbs: round3(summary.totalRealLbs),
          totalRealAmount: round2(summary.totalRealAmount),
          totalDifferenceLbs: round3(summary.totalDifferenceLbs),
          totalDifferenceAmount: round2(summary.totalDifferenceAmount),
        },
        generalObservation: generalObservation.trim() || null,
        rows: rows.map((r) => ({
          productId: r.productId,
          productName: r.productName,
          salePrice: round2(r.salePrice),
          costPrice: round2(r.costPrice),
          theoreticalLbs: round3(r.theoreticalLbs),
          theoreticalAmount: round2(r.theoreticalAmount),
          realLbs: r.realLbs === "" ? null : round3(r.realLbs),
          realAmount: round2(r.realAmount),
          differenceLbs: round3(r.differenceLbs),
          differenceAmount: round2(r.differenceAmount),
          observation: r.observation.trim() || null,
          batchCount: r.batchCount,
        })),
      };

      await addDoc(collection(db, "inventory_audits_pollo"), payload);

      window.alert("Arqueo guardado correctamente.");
      setCreateOpen(false);
      resetCreateForm();
      refresh();
    } catch (e) {
      console.error("Error guardando arqueo:", e);
      window.alert("No se pudo guardar el arqueo. Revisa la consola.");
    } finally {
      setSaving(false);
    }
  };

  const exportSavedAuditExcel = (audit: SavedAudit) => {
    const wb = XLSX.utils.book_new();

    const s = audit.summary || {
      totalTheoreticalLbs: 0,
      totalTheoreticalAmount: 0,
      totalRealLbs: 0,
      totalRealAmount: 0,
      totalDifferenceLbs: 0,
      totalDifferenceAmount: 0,
    };

    const summaryRows = [
      ["Fecha inicio", audit.from || ""],
      ["Fecha final", audit.to || ""],
      ["Auditor", getCreatedByLabel(audit)],
      ["Productos auditados", audit.rows?.length || 0],
      ["Total libras teóricas", round3(s.totalTheoreticalLbs)],
      ["Total monto teórico", round2(s.totalTheoreticalAmount)],
      ["Total libras reales", round3(s.totalRealLbs)],
      ["Total monto real", round2(s.totalRealAmount)],
      ["Total diferencia lb", round3(s.totalDifferenceLbs)],
      ["Total monto diferencia", round2(s.totalDifferenceAmount)],
      ["Observación general", audit.generalObservation || ""],
    ];

    const detailRows = [
      [
        "Producto",
        "Product ID",
        "Precio venta",
        "Precio costo",
        "Libras teóricas",
        "Monto teórico",
        "Libras reales",
        "Monto real",
        "Diferencia lb",
        "Monto diferencia",
        "Observación",
      ],
      ...((audit.rows || []).map((r) => [
        r.productName,
        r.productId,
        round2(r.salePrice),
        round2(r.costPrice),
        round3(r.theoreticalLbs),
        round2(r.theoreticalAmount),
        r.realLbs ?? "",
        round2(r.realAmount),
        round3(r.differenceLbs),
        round2(r.differenceAmount),
        r.observation || "",
      ]) as (string | number | null)[][]),
    ];

    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet(summaryRows),
      "Resumen",
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet(detailRows),
      "Detalle",
    );
    XLSX.writeFile(
      wb,
      `detalle_arqueo_${audit.from || "desde"}_${audit.to || "hasta"}.xlsx`,
    );
  };

  const updateEditRealLbs = (productId: string, value: string) => {
    setEditRows((prev) =>
      (prev || []).map((r) => {
        if (r.productId !== productId) return r;

        const normalized = value.replace(/,/g, ".").trim();

        if (normalized === "") {
          return {
            ...r,
            realLbs: null,
            realAmount: 0,
            differenceLbs: round3(0 - Number(r.theoreticalLbs || 0)),
            differenceAmount: 0,
          } as any;
        }

        if (!/^\d*(\.\d{0,3})?$/.test(normalized)) return r;
        const num = Number(normalized);
        if (!Number.isFinite(num) || num < 0) return r;

        const salePrice = Number(r.salePrice || 0) || 0;
        const realAmount = round2(num * salePrice);
        const differenceLbs = round3(num - Number(r.theoreticalLbs || 0));
        const differenceAmount = round2(differenceLbs * salePrice);

        return {
          ...r,
          realLbs: round3(num),
          realAmount,
          differenceLbs,
          differenceAmount,
        } as any;
      }),
    );
  };

  const removeEditRow = (productId: string) => {
    if (!window.confirm("¿Eliminar este producto del arqueo?")) return;
    setEditRows((prev) =>
      (prev || []).filter((r) => r.productId !== productId),
    );
  };

  useEffect(() => {
    // debug: track edit modal state changes
    // eslint-disable-next-line no-console
    console.log("ArqueoProducto state change", {
      editOpen,
      selectedAuditId: selectedAudit?.id ?? null,
      editRowsLength: (editRows || []).length,
    });
  }, [editOpen, selectedAudit, editRows]);

  return (
    <div className="max-w-7xl mx-auto bg-white p-4 sm:p-6 rounded-2xl shadow-2xl">
      <div className="flex items-center justify-between mb-3 gap-2">
        <h2 className="text-xl sm:text-2xl font-bold">Arqueo de Producto</h2>

        <div className="flex items-center gap-2">
          <RefreshButton onClick={refresh} loading={loadingList} />
          <button
            type="button"
            onClick={() => {
              resetCreateForm();
              setCreateOpen(true);
            }}
            className="px-3 py-2 rounded bg-blue-600 hover:bg-blue-700 text-white text-sm"
          >
            Nuevo arqueo
          </button>
        </div>
      </div>

      {/* filtros listado */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
        <div>
          <label className="block text-sm text-gray-600 mb-1">Desde</label>
          <input
            type="date"
            className="border rounded px-3 py-2 w-full"
            value={fromFilter}
            onChange={(e) => setFromFilter(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-600 mb-1">Hasta</label>
          <input
            type="date"
            className="border rounded px-3 py-2 w-full"
            value={toFilter}
            onChange={(e) => setToFilter(e.target.value)}
          />
        </div>
      </div>

      {/* KPIs listado */}
      <div className="hidden md:grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <div className="border rounded-2xl p-3 bg-gray-50">
          <div className="text-xs text-gray-600">Arqueos registrados</div>
          <div className="text-2xl font-bold">{filteredAudits.length}</div>
        </div>

        <div className="border rounded-2xl p-3 bg-indigo-50">
          <div className="text-xs text-gray-600">Total libras teóricas</div>
          <div className="text-2xl font-bold">
            {qty3(
              filteredAudits.reduce(
                (a, x) => a + Number(x.summary?.totalTheoreticalLbs || 0),
                0,
              ),
            )}
          </div>
        </div>

        <div className="border rounded-2xl p-3 bg-amber-50">
          <div className="text-xs text-gray-600">Total diferencia lb</div>
          <div className="text-2xl font-bold">
            {qty3(
              filteredAudits.reduce(
                (a, x) => a + Number(x.summary?.totalDifferenceLbs || 0),
                0,
              ),
            )}
          </div>
        </div>

        <div className="border rounded-2xl p-3 bg-red-50">
          <div className="text-xs text-gray-600">Total monto diferencia</div>
          <div className="text-2xl font-bold">
            {money(
              filteredAudits.reduce(
                (a, x) => a + Number(x.summary?.totalDifferenceAmount || 0),
                0,
              ),
            )}
          </div>
        </div>
      </div>

      {/* tabla desktop listado */}
      <div className="hidden md:block overflow-x-auto">
        <table className="min-w-full border text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="border p-2">Fecha arqueo</th>
              <th className="border p-2">Auditor</th>
              <th className="border p-2">Productos auditados</th>
              <th className="border p-2">Libras teóricas</th>
              <th className="border p-2">Libras reales</th>
              <th className="border p-2">Diferencia lb</th>
              <th className="border p-2">Monto diferencia</th>
              <th className="border p-2">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {filteredAudits.map((a) => (
              <tr key={a.id} className="text-center">
                <td className="border p-1">
                  <div className="font-medium">{a.to || "—"}</div>
                  <div className="text-[11px] text-gray-500">
                    {a.from || "—"} → {a.to || "—"}
                  </div>
                </td>
                <td className="border p-1">{getCreatedByLabel(a)}</td>
                <td className="border p-1">{a.rows?.length || 0}</td>
                <td className="border p-1">
                  {qty3(a.summary?.totalTheoreticalLbs || 0)}
                </td>
                <td className="border p-1">
                  {qty3(a.summary?.totalRealLbs || 0)}
                </td>
                <td
                  className={`border p-1 ${diffClass(a.summary?.totalDifferenceLbs || 0)}`}
                >
                  {qty3(a.summary?.totalDifferenceLbs || 0)}
                </td>
                <td
                  className={`border p-1 ${diffClass(
                    a.summary?.totalDifferenceAmount || 0,
                  )}`}
                >
                  {money(a.summary?.totalDifferenceAmount || 0)}
                </td>
                <td className="border p-1">
                  <div className="relative inline-block text-left">
                    <button
                      type="button"
                      className="p-2 rounded-full border hover:bg-gray-100 focus:outline-none"
                      onClick={(e) => {
                        const btn = e.currentTarget as HTMLButtonElement;
                        const rect = btn.getBoundingClientRect();
                        // debug: log opening intent
                        // eslint-disable-next-line no-console
                        console.log("menu button click", { id: a.id, rect });
                        setOpenMenu({ id: a.id, rect });
                      }}
                    >
                      <span className="sr-only">Abrir menú</span>
                      <svg
                        width="24"
                        height="24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="feather feather-menu"
                      >
                        <line x1="3" y1="12" x2="21" y2="12" />
                        <line x1="3" y1="6" x2="21" y2="6" />
                        <line x1="3" y1="18" x2="21" y2="18" />
                      </svg>
                    </button>
                    <ActionMenu
                      anchorRect={openMenu.rect}
                      isOpen={openMenu.id === a.id}
                      onClose={() => setOpenMenu({ id: null, rect: null })}
                      width={168}
                    >
                      <button
                        type="button"
                        className="block w-full text-left px-4 py-2 hover:bg-gray-100"
                        onClick={() => {
                          setSelectedAudit(a);
                          setDetailOpen(true);
                          setOpenMenu({ id: null, rect: null });
                        }}
                      >
                        Ver detalle
                      </button>
                      <button
                        type="button"
                        className="block w-full text-left px-4 py-2 hover:bg-gray-100"
                        onClick={() => {
                          exportSavedAuditExcel(a);
                          setOpenMenu({ id: null, rect: null });
                        }}
                      >
                        Excel
                      </button>
                      <button
                        type="button"
                        className="block w-full text-left px-4 py-2 hover:bg-gray-100"
                        onClick={() => {
                          // open edit modal first, then close the menu shortly after
                          setSelectedAudit(a);
                          setEditOpen(true);
                          setTimeout(
                            () => setOpenMenu({ id: null, rect: null }),
                            150,
                          );
                        }}
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        className="block w-full text-left px-4 py-2 hover:bg-red-100 text-red-600"
                        onClick={() => {
                          handleDeleteAudit(a.id);
                          setOpenMenu({ id: null, rect: null });
                        }}
                      >
                        Eliminar
                      </button>
                    </ActionMenu>
                    {/* Direct edit shortcut (temporary) */}
                    <button
                      type="button"
                      className="ml-2 px-2 py-1 border rounded text-sm"
                      onClick={() => {
                        // debug: direct edit click
                        // eslint-disable-next-line no-console
                        console.log("direct edit click", { id: a.id });
                        setSelectedAudit(a);
                        setEditOpen(true);
                        setOpenMenu({ id: null, rect: null });
                      }}
                    >
                      Editar
                    </button>
                  </div>
                </td>
              </tr>
            ))}

            {!filteredAudits.length && (
              <tr>
                <td colSpan={8} className="p-3 text-center text-gray-500">
                  No hay arqueos registrados en este rango.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* listado mobile */}
      <div className="md:hidden space-y-3">
        {filteredAudits.length === 0 ? (
          <div className="text-center text-gray-500 text-sm py-6">
            No hay arqueos registrados en este rango.
          </div>
        ) : (
          filteredAudits.map((a) => (
            <div
              key={a.id}
              className="border rounded-xl p-3 bg-white shadow-sm"
            >
              <div className="flex justify-between items-start gap-2">
                <div>
                  <div className="text-sm font-semibold">{a.to || "—"}</div>
                  <div className="text-xs text-gray-500">
                    {a.from || "—"} → {a.to || "—"}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-gray-500">Auditor</div>
                  <div className="text-sm">{getCreatedByLabel(a)}</div>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                <div className="border rounded p-2 bg-gray-50">
                  <div className="text-xs text-gray-500">Productos</div>
                  <div className="font-semibold">{a.rows?.length || 0}</div>
                </div>

                <div className="border rounded p-2 bg-gray-50">
                  <div className="text-xs text-gray-500">Lbs teóricas</div>
                  <div className="font-semibold">
                    {qty3(a.summary?.totalTheoreticalLbs || 0)}
                  </div>
                </div>

                <div className="border rounded p-2 bg-amber-50">
                  <div className="text-xs text-gray-500">Diferencia lb</div>
                  <div
                    className={`font-semibold ${diffClass(a.summary?.totalDifferenceLbs || 0)}`}
                  >
                    {qty3(a.summary?.totalDifferenceLbs || 0)}
                  </div>
                </div>

                <div className="border rounded p-2 bg-red-50">
                  <div className="text-xs text-gray-500">Monto diferencia</div>
                  <div
                    className={`font-semibold ${diffClass(
                      a.summary?.totalDifferenceAmount || 0,
                    )}`}
                  >
                    {money(a.summary?.totalDifferenceAmount || 0)}
                  </div>
                </div>
              </div>

              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedAudit(a);
                    setDetailOpen(true);
                  }}
                  className="px-3 py-1 border rounded text-sm"
                >
                  Ver detalle
                </button>
                <button
                  type="button"
                  onClick={() => exportSavedAuditExcel(a)}
                  className="px-3 py-1 border rounded text-sm"
                >
                  Excel
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* modal crear arqueo */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4">
          <div className="absolute inset-0 bg-black/50" />

          <div
            ref={createModalRef}
            className="relative bg-white rounded-2xl shadow-2xl w-full max-w-[98vw] h-[96vh] overflow-hidden"
          >
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div>
                <h3 className="text-lg sm:text-xl font-bold">Nuevo Arqueo</h3>
                <div className="text-sm text-gray-500">
                  Control de inventario físico de pollo
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={exportCreateExcel}
                  className="px-3 py-2 border rounded bg-white hover:bg-gray-50 text-sm"
                  disabled={!rows.length}
                >
                  Exportar Excel
                </button>

                <button
                  type="button"
                  onClick={saveAudit}
                  className="px-3 py-2 rounded bg-blue-600 hover:bg-blue-700 text-white text-sm disabled:opacity-60"
                  disabled={saving || !rows.length}
                >
                  {saving ? "Guardando..." : "Guardar arqueo"}
                </button>

                <button
                  type="button"
                  onClick={() => setCreateOpen(false)}
                  className="px-3 py-2 border rounded text-sm"
                >
                  Cerrar
                </button>
              </div>
            </div>

            <div className="h-[calc(96vh-65px)] overflow-y-auto p-4">
              {/* filtros del modal */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 mb-4">
                <div>
                  <label className="block text-sm text-gray-600 mb-1">
                    Fecha control inicio
                  </label>
                  <input
                    type="date"
                    className="border rounded px-3 py-2 w-full"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </div>

                <div>
                  <label className="block text-sm text-gray-600 mb-1">
                    Fecha control final
                  </label>
                  <input
                    type="date"
                    className="border rounded px-3 py-2 w-full"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </div>

                <div>
                  <label className="block text-sm text-gray-600 mb-1">
                    Buscar producto
                  </label>
                  <input
                    className="border rounded px-3 py-2 w-full"
                    value={productFilter}
                    onChange={(e) => setProductFilter(e.target.value)}
                    placeholder="Nombre o ID"
                  />
                </div>

                <div>
                  <label className="block text-sm text-gray-600 mb-1">
                    Estado diferencia
                  </label>
                  <select
                    className="border rounded px-3 py-2 w-full"
                    value={diffFilter}
                    onChange={(e) => setDiffFilter(e.target.value as any)}
                  >
                    <option value="ALL">Todos</option>
                    <option value="WITH_DIFF">Solo con diferencia</option>
                    <option value="MATCHED">Solo coinciden</option>
                    <option value="MISSING_REAL">Sin conteo real</option>
                  </select>
                </div>
              </div>

              <div className="mb-4 flex flex-col sm:flex-row sm:items-center gap-3">
                <button
                  type="button"
                  onClick={loadRows}
                  className="bg-blue-600 text-white px-3 py-2 text-sm rounded-lg hover:bg-blue-700 w-full sm:w-auto disabled:opacity-60"
                  disabled={loadingProducts}
                >
                  {loadingProducts ? "Cargando..." : "Cargar productos"}
                </button>

                <div className="text-sm text-gray-600">
                  {loaded
                    ? `Productos cargados: ${rows.length} • Con conteo real: ${enteredCount} • Con diferencia: ${differencesCount}`
                    : "Cargá los productos para iniciar el arqueo."}
                </div>
              </div>

              {/* KPIs */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 mb-4">
                <div className="border rounded-2xl p-3 bg-gray-50">
                  <div className="text-xs text-gray-600">Libras teóricas</div>
                  <div className="text-2xl font-bold">
                    {qty3(summary.totalTheoreticalLbs)}
                  </div>
                </div>

                <div className="border rounded-2xl p-3 bg-indigo-50">
                  <div className="text-xs text-gray-600">Monto teórico</div>
                  <div className="text-2xl font-bold">
                    {money(summary.totalTheoreticalAmount)}
                  </div>
                </div>

                <div className="border rounded-2xl p-3 bg-blue-50">
                  <div className="text-xs text-gray-600">Libras reales</div>
                  <div className="text-2xl font-bold">
                    {qty3(summary.totalRealLbs)}
                  </div>
                </div>

                <div className="border rounded-2xl p-3 bg-emerald-50">
                  <div className="text-xs text-gray-600">Monto real</div>
                  <div className="text-2xl font-bold">
                    {money(summary.totalRealAmount)}
                  </div>
                </div>

                <div className="border rounded-2xl p-3 bg-amber-50">
                  <div className="text-xs text-gray-600">Diferencia lb</div>
                  <div
                    className={`text-2xl font-bold ${diffClass(summary.totalDifferenceLbs)}`}
                  >
                    {qty3(summary.totalDifferenceLbs)}
                  </div>
                </div>

                <div className="border rounded-2xl p-3 bg-red-50">
                  <div className="text-xs text-gray-600">Monto diferencia</div>
                  <div
                    className={`text-2xl font-bold ${diffClass(
                      summary.totalDifferenceAmount,
                    )}`}
                  >
                    {money(summary.totalDifferenceAmount)}
                  </div>
                </div>
              </div>

              <div className="mb-4">
                <label className="block text-sm text-gray-600 mb-1">
                  Observación general
                </label>
                <textarea
                  className="border rounded px-3 py-2 w-full min-h-[90px]"
                  value={generalObservation}
                  onChange={(e) => setGeneralObservation(e.target.value)}
                  placeholder="Notas generales del arqueo..."
                />
              </div>

              {/* tabla desktop del modal */}
              <div className="hidden md:block overflow-x-auto">
                <table className="min-w-full border text-sm">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="border p-2">Producto</th>
                      <th className="border p-2">Precio venta</th>
                      <th className="border p-2">Precio costo</th>
                      <th className="border p-2">Libras teóricas</th>
                      <th className="border p-2">Monto teórico</th>
                      <th className="border p-2">Libras reales</th>
                      <th className="border p-2">Monto real</th>
                      <th className="border p-2">Diferencia lb</th>
                      <th className="border p-2">Monto diferencia</th>
                      <th className="border p-2">Obs.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map((r) => (
                      <tr key={r.productId} className="text-center">
                        <td className="border p-1 text-left">
                          <div className="font-medium">{r.productName}</div>
                          <div className="text-[11px] text-gray-500">
                            {r.productId} • lotes: {r.batchCount}
                          </div>
                        </td>

                        <td className="border p-1">{money(r.salePrice)}</td>
                        <td className="border p-1">{money(r.costPrice)}</td>
                        <td className="border p-1">{qty3(r.theoreticalLbs)}</td>
                        <td className="border p-1">
                          {money(r.theoreticalAmount)}
                        </td>

                        <td className="border p-1">
                          <input
                            type="text"
                            inputMode="decimal"
                            className="border rounded px-2 py-1 w-28 text-right"
                            value={r.realLbs === "" ? "" : String(r.realLbs)}
                            onChange={(e) =>
                              updateRealLbs(r.productId, e.target.value)
                            }
                            placeholder="0.000"
                          />
                        </td>

                        <td className="border p-1">{money(r.realAmount)}</td>

                        <td
                          className={`border p-1 ${diffClass(r.differenceLbs)}`}
                        >
                          {qty3(r.differenceLbs)}
                        </td>

                        <td
                          className={`border p-1 ${diffClass(r.differenceAmount)}`}
                        >
                          {money(r.differenceAmount)}
                        </td>

                        <td className="border p-1">
                          <input
                            className="border rounded px-2 py-1 w-full"
                            value={r.observation}
                            onChange={(e) =>
                              updateObservation(r.productId, e.target.value)
                            }
                            placeholder="Observación"
                          />
                        </td>
                      </tr>
                    ))}

                    {!filteredRows.length && (
                      <tr>
                        <td
                          colSpan={10}
                          className="p-3 text-center text-gray-500"
                        >
                          No hay productos para mostrar.
                        </td>
                      </tr>
                    )}

                    {!!filteredRows.length && (
                      <tr className="bg-indigo-50 font-semibold text-center">
                        <td className="border p-2 text-left">Totales</td>
                        <td className="border p-2">—</td>
                        <td className="border p-2">—</td>
                        <td className="border p-2">
                          {qty3(summary.totalTheoreticalLbs)}
                        </td>
                        <td className="border p-2">
                          {money(summary.totalTheoreticalAmount)}
                        </td>
                        <td className="border p-2">
                          {qty3(summary.totalRealLbs)}
                        </td>
                        <td className="border p-2">
                          {money(summary.totalRealAmount)}
                        </td>
                        <td
                          className={`border p-2 ${diffClass(
                            summary.totalDifferenceLbs,
                          )}`}
                        >
                          {qty3(summary.totalDifferenceLbs)}
                        </td>
                        <td
                          className={`border p-2 ${diffClass(
                            summary.totalDifferenceAmount,
                          )}`}
                        >
                          {money(summary.totalDifferenceAmount)}
                        </td>
                        <td className="border p-2">—</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* mobile del modal */}
              <div className="md:hidden space-y-3">
                {!filteredRows.length ? (
                  <div className="text-center text-gray-500 text-sm py-6">
                    No hay productos para mostrar.
                  </div>
                ) : (
                  filteredRows.map((r) => (
                    <div
                      key={r.productId}
                      className="border rounded-xl p-3 bg-white shadow-sm"
                    >
                      <div className="flex justify-between items-start gap-2">
                        <div>
                          <div className="text-sm font-semibold">
                            {r.productName}
                          </div>
                          <div className="text-xs text-gray-500">
                            {r.productId} • lotes: {r.batchCount}
                          </div>
                        </div>

                        <div className="text-right">
                          <div className="text-xs text-gray-500">
                            Diferencia
                          </div>
                          <div
                            className={`font-semibold ${diffClass(r.differenceLbs)}`}
                          >
                            {qty3(r.differenceLbs)}
                          </div>
                        </div>
                      </div>

                      <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                        <div className="border rounded p-2 bg-gray-50">
                          <div className="text-xs text-gray-500">
                            Precio venta
                          </div>
                          <div className="font-semibold">
                            {money(r.salePrice)}
                          </div>
                        </div>

                        <div className="border rounded p-2 bg-gray-50">
                          <div className="text-xs text-gray-500">
                            Precio costo
                          </div>
                          <div className="font-semibold">
                            {money(r.costPrice)}
                          </div>
                        </div>

                        <div className="border rounded p-2 bg-gray-50">
                          <div className="text-xs text-gray-500">
                            Lbs teóricas
                          </div>
                          <div className="font-semibold">
                            {qty3(r.theoreticalLbs)}
                          </div>
                        </div>

                        <div className="border rounded p-2 bg-gray-50">
                          <div className="text-xs text-gray-500">
                            Monto teórico
                          </div>
                          <div className="font-semibold">
                            {money(r.theoreticalAmount)}
                          </div>
                        </div>

                        <div className="border rounded p-2 bg-blue-50 col-span-2">
                          <div className="text-xs text-gray-500 mb-1">
                            Libras reales
                          </div>
                          <input
                            type="text"
                            inputMode="decimal"
                            className="border rounded px-3 py-2 w-full"
                            value={r.realLbs === "" ? "" : String(r.realLbs)}
                            onChange={(e) =>
                              updateRealLbs(r.productId, e.target.value)
                            }
                            placeholder="0.000"
                          />
                        </div>

                        <div className="border rounded p-2 bg-emerald-50">
                          <div className="text-xs text-gray-500">
                            Monto real
                          </div>
                          <div className="font-semibold">
                            {money(r.realAmount)}
                          </div>
                        </div>

                        <div className="border rounded p-2 bg-amber-50">
                          <div className="text-xs text-gray-500">
                            Monto diferencia
                          </div>
                          <div
                            className={`font-semibold ${diffClass(r.differenceAmount)}`}
                          >
                            {money(r.differenceAmount)}
                          </div>
                        </div>

                        <div className="col-span-2">
                          <div className="text-xs text-gray-500 mb-1">
                            Observación
                          </div>
                          <input
                            className="border rounded px-3 py-2 w-full"
                            value={r.observation}
                            onChange={(e) =>
                              updateObservation(r.productId, e.target.value)
                            }
                            placeholder="Observación"
                          />
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* modal detalle */}
      {detailOpen && selectedAudit && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-2 sm:p-4">
          <div className="absolute inset-0 bg-black/50" />

          <div
            ref={detailModalRef}
            className="relative bg-white rounded-2xl shadow-2xl w-full max-w-[98vw] h-[96vh] overflow-hidden"
          >
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div>
                <h3 className="text-lg sm:text-xl font-bold">
                  Detalle de Arqueo
                </h3>
                <div className="text-sm text-gray-500">
                  {selectedAudit.from || "—"} → {selectedAudit.to || "—"}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => exportSavedAuditExcel(selectedAudit)}
                  className="px-3 py-2 border rounded bg-white hover:bg-gray-50 text-sm"
                >
                  Exportar Excel
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setDetailOpen(false);
                    setSelectedAudit(null);
                  }}
                  className="px-3 py-2 border rounded text-sm"
                >
                  Cerrar
                </button>
              </div>
            </div>

            <div className="h-[calc(96vh-65px)] overflow-y-auto p-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 mb-4">
                <div className="border rounded-2xl p-3 bg-gray-50">
                  <div className="text-xs text-gray-600">Auditor</div>
                  <div className="text-sm font-semibold">
                    {getCreatedByLabel(selectedAudit)}
                  </div>
                </div>

                <div className="border rounded-2xl p-3 bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Productos auditados
                  </div>
                  <div className="text-2xl font-bold">
                    {selectedAudit.rows?.length || 0}
                  </div>
                </div>

                <div className="border rounded-2xl p-3 bg-indigo-50">
                  <div className="text-xs text-gray-600">Libras teóricas</div>
                  <div className="text-2xl font-bold">
                    {qty3(selectedAudit.summary?.totalTheoreticalLbs || 0)}
                  </div>
                </div>

                <div className="border rounded-2xl p-3 bg-blue-50">
                  <div className="text-xs text-gray-600">Libras reales</div>
                  <div className="text-2xl font-bold">
                    {qty3(selectedAudit.summary?.totalRealLbs || 0)}
                  </div>
                </div>

                <div className="border rounded-2xl p-3 bg-amber-50">
                  <div className="text-xs text-gray-600">Diferencia lb</div>
                  <div
                    className={`text-2xl font-bold ${diffClass(
                      selectedAudit.summary?.totalDifferenceLbs || 0,
                    )}`}
                  >
                    {qty3(selectedAudit.summary?.totalDifferenceLbs || 0)}
                  </div>
                </div>

                <div className="border rounded-2xl p-3 bg-red-50">
                  <div className="text-xs text-gray-600">Monto diferencia</div>
                  <div
                    className={`text-2xl font-bold ${diffClass(
                      selectedAudit.summary?.totalDifferenceAmount || 0,
                    )}`}
                  >
                    {money(selectedAudit.summary?.totalDifferenceAmount || 0)}
                  </div>
                </div>
              </div>

              {!!selectedAudit.generalObservation && (
                <div className="mb-4 border rounded-2xl p-3 bg-gray-50">
                  <div className="text-xs text-gray-600 mb-1">
                    Observación general
                  </div>
                  <div className="text-sm">
                    {selectedAudit.generalObservation}
                  </div>
                </div>
              )}

              <div className="hidden md:block overflow-x-auto">
                <table className="min-w-full border text-sm">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="border p-2">Producto</th>
                      <th className="border p-2">Precio venta</th>
                      <th className="border p-2">Precio costo</th>
                      <th className="border p-2">Libras teóricas</th>
                      <th className="border p-2">Monto teórico</th>
                      <th className="border p-2">Libras reales</th>
                      <th className="border p-2">Monto real</th>
                      <th className="border p-2">Diferencia lb</th>
                      <th className="border p-2">Monto diferencia</th>
                      <th className="border p-2">Obs.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(selectedAudit.rows || []).map((r, idx) => (
                      <tr key={`${r.productId}_${idx}`} className="text-center">
                        <td className="border p-1 text-left">
                          <div className="font-medium">{r.productName}</div>
                          <div className="text-[11px] text-gray-500">
                            {r.productId}
                          </div>
                        </td>
                        <td className="border p-1">{money(r.salePrice)}</td>
                        <td className="border p-1">{money(r.costPrice)}</td>
                        <td className="border p-1">{qty3(r.theoreticalLbs)}</td>
                        <td className="border p-1">
                          {money(r.theoreticalAmount)}
                        </td>
                        <td className="border p-1">
                          {r.realLbs == null ? "—" : qty3(r.realLbs)}
                        </td>
                        <td className="border p-1">{money(r.realAmount)}</td>
                        <td
                          className={`border p-1 ${diffClass(r.differenceLbs)}`}
                        >
                          {qty3(r.differenceLbs)}
                        </td>
                        <td
                          className={`border p-1 ${diffClass(r.differenceAmount)}`}
                        >
                          {money(r.differenceAmount)}
                        </td>
                        <td className="border p-1 text-left">
                          {r.observation || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="md:hidden space-y-3">
                {(selectedAudit.rows || []).map((r, idx) => (
                  <div
                    key={`${r.productId}_${idx}`}
                    className="border rounded-xl p-3 bg-white shadow-sm"
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div>
                        <div className="text-sm font-semibold">
                          {r.productName}
                        </div>
                        <div className="text-xs text-gray-500">
                          {r.productId}
                        </div>
                      </div>

                      <div className="text-right">
                        <div className="text-xs text-gray-500">Diferencia</div>
                        <div
                          className={`font-semibold ${diffClass(r.differenceLbs)}`}
                        >
                          {qty3(r.differenceLbs)}
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                      <div className="border rounded p-2 bg-gray-50">
                        <div className="text-xs text-gray-500">
                          Precio venta
                        </div>
                        <div className="font-semibold">
                          {money(r.salePrice)}
                        </div>
                      </div>

                      <div className="border rounded p-2 bg-gray-50">
                        <div className="text-xs text-gray-500">
                          Precio costo
                        </div>
                        <div className="font-semibold">
                          {money(r.costPrice)}
                        </div>
                      </div>

                      <div className="border rounded p-2 bg-gray-50">
                        <div className="text-xs text-gray-500">
                          Lbs teóricas
                        </div>
                        <div className="font-semibold">
                          {qty3(r.theoreticalLbs)}
                        </div>
                      </div>

                      <div className="border rounded p-2 bg-gray-50">
                        <div className="text-xs text-gray-500">Lbs reales</div>
                        <div className="font-semibold">
                          {r.realLbs == null ? "—" : qty3(r.realLbs)}
                        </div>
                      </div>

                      <div className="border rounded p-2 bg-gray-50">
                        <div className="text-xs text-gray-500">
                          Monto teórico
                        </div>
                        <div className="font-semibold">
                          {money(r.theoreticalAmount)}
                        </div>
                      </div>

                      <div className="border rounded p-2 bg-gray-50">
                        <div className="text-xs text-gray-500">Monto real</div>
                        <div className="font-semibold">
                          {money(r.realAmount)}
                        </div>
                      </div>

                      <div className="border rounded p-2 bg-amber-50 col-span-2">
                        <div className="text-xs text-gray-500">
                          Monto diferencia
                        </div>
                        <div
                          className={`font-semibold ${diffClass(r.differenceAmount)}`}
                        >
                          {money(r.differenceAmount)}
                        </div>
                      </div>

                      <div className="col-span-2 border rounded p-2 bg-gray-50">
                        <div className="text-xs text-gray-500">Observación</div>
                        <div>{r.observation || "—"}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
