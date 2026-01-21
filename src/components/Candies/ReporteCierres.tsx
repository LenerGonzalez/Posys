// src/components/Candies/Liquidaciones.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { db } from "../../firebase";
import {
  collection,
  getDocs,
  query,
  where,
  doc,
  getDoc,
} from "firebase/firestore";
import { format, subDays } from "date-fns";
import { hasRole } from "../../utils/roles";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";

type RoleCandies =
  | ""
  | "admin"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces"
  | "supervisor_pollo"
  | "contador";

type SaleType = "CONTADO" | "CREDITO";

type FireTimestamp = { toDate?: () => Date } | undefined;

interface ClosureDoc {
  id: string;
  date: string; // fecha de cierre (proceso) "yyyy-MM-dd"
  createdAt?: any;

  periodStart?: string;
  periodEnd?: string;

  totalCharged?: number;
  totalUnits?: number;

  // ✅ tu cierre guarda sales[]
  sales?: Array<{
    id?: string; // ej: BsC5...#0
    productName?: string;
    quantity?: number;
    amount?: number;
    userEmail?: string;
    date?: string; // fecha venta
    processedDate?: string;
  }>;
}

interface SellerCandy {
  id: string;
  name: string;
  commissionPercent: number;
}

interface SaleDataRaw {
  // base
  date?: string;
  timestamp?: FireTimestamp;

  // tipo
  type?: SaleType;

  // vendedor
  userEmail?: string;
  vendor?: string;
  vendorName?: string;
  vendorId?: string;

  // montos
  amount?: number;
  amountCharged?: number;
  total?: number;
  itemsTotal?: number;

  // qty
  quantity?: number;
  packagesTotal?: number;

  // comisión
  vendorCommissionAmount?: number;

  // multi item
  items?: any[];
}

interface SaleData {
  id: string; // docId#idx
  productName: string;
  quantity: number; // paquetes
  amount: number;
  date: string; // fecha venta
  type: SaleType;

  vendorId?: string;
  userEmail: string; // label vendedor

  vendorCommissionAmount?: number; // comisión por fila (ya prorrateada)
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const round3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;
const money = (n: unknown) => Number(n ?? 0).toFixed(2);
const qty3 = (n: unknown) => Number(n ?? 0).toFixed(3);

// ===== Normaliza ventas del doc sales_candies (igual estilo que CierreVentasDulces) =====
const normalizeMany = (raw: SaleDataRaw, id: string): SaleData[] => {
  const date =
    raw.date ??
    (raw.timestamp?.toDate
      ? format(raw.timestamp.toDate()!, "yyyy-MM-dd")
      : "");
  if (!date) return [];

  const sellerEmail = raw.userEmail ?? "";
  const vendedorLabel =
    raw.vendorName ||
    raw.vendor ||
    sellerEmail ||
    raw.vendorId ||
    "(sin vendedor)";

  const type: SaleType = (raw.type || "CONTADO") as SaleType;
  const vendorId = raw.vendorId;

  const saleTotalRoot =
    Number(
      raw.total ?? raw.itemsTotal ?? raw.amount ?? raw.amountCharged ?? 0,
    ) || 0;

  const saleCommissionRoot = Number(raw.vendorCommissionAmount ?? 0) || 0;

  // Multi item
  if (Array.isArray(raw.items) && raw.items.length > 0) {
    return raw.items.map((it, idx) => {
      const qtyPacks = Number(it?.packages ?? it?.qty ?? it?.quantity ?? 0);
      const lineFinal =
        Number(it?.lineFinal ?? 0) ||
        Math.max(
          0,
          Number(it?.unitPricePackage || it?.unitPrice || 0) * qtyPacks -
            Number(it?.discount || 0),
        );

      // comisión prorrateada por línea (si viene commission en root)
      let lineCommission = 0;
      if (
        saleCommissionRoot > 0 &&
        saleTotalRoot > 0 &&
        Number(lineFinal || 0) > 0
      ) {
        lineCommission = round2(
          (saleCommissionRoot * Number(lineFinal || 0)) / saleTotalRoot,
        );
      }

      return {
        id: `${id}#${idx}`,
        productName: String(it?.productName ?? "(sin nombre)"),
        quantity: qtyPacks,
        amount: round2(lineFinal),
        date,
        type,
        vendorId,
        userEmail: vendedorLabel,
        vendorCommissionAmount: lineCommission,
      };
    });
  }

  // Single row
  const qtyPacksFallback = Number(raw.packagesTotal ?? raw.quantity ?? 0);
  const amountFallback =
    Number(raw.amount ?? raw.amountCharged ?? raw.total ?? 0) || 0;

  const commissionFallback = round2(
    Number(raw.vendorCommissionAmount ?? 0) || 0,
  );

  return [
    {
      id,
      productName: String((raw as any)?.productName ?? "(sin nombre)"),
      quantity: qtyPacksFallback,
      amount: round2(amountFallback),
      date,
      type,
      vendorId,
      userEmail: vendedorLabel,
      vendorCommissionAmount: commissionFallback,
    },
  ];
};

export default function Liquidaciones({
  role,
  roles,
  currentUserEmail,
  sellerCandyId,
}: {
  role?: string;
  roles?: string[];
  currentUserEmail?: string;
  sellerCandyId?: string;
}): React.ReactElement {
  const subject = roles && roles.length ? roles : role;
  const isAdmin = !subject || hasRole(subject, "admin");

  // ✅ colecciones reales
  const CLOSURES_COL = "daily_closures_candies";
  const SALES_COL = "sales_candies";
  const SELLERS_COL = "sellers_candies";

  const [startDate, setStartDate] = useState<string>(
    format(subDays(new Date(), 14), "yyyy-MM-dd"),
  );
  const [endDate, setEndDate] = useState<string>(
    format(new Date(), "yyyy-MM-dd"),
  );

  const [loading, setLoading] = useState<boolean>(true);
  const [closures, setClosures] = useState<ClosureDoc[]>([]);
  const [selected, setSelected] = useState<ClosureDoc | null>(null);

  const [message, setMessage] = useState<string>("");

  const [sellers, setSellers] = useState<SellerCandy[]>([]);
  const [vendorFilter, setVendorFilter] = useState<string>("ALL");

  // cache: docId -> SaleData[] normalizado
  const [saleCache, setSaleCache] = useState<Record<string, SaleData[]>>({});

  const detailRef = useRef<HTMLDivElement>(null);

  if (!isAdmin) {
    return (
      <div className="max-w-7xl mx-auto p-6 bg-white rounded-2xl shadow-2xl">
        <h1 className="text-2xl font-bold mb-2">Liquidaciones</h1>
        <p className="text-sm text-red-600">Acceso denegado: solo admin.</p>
      </div>
    );
  }

  const fetchSellers = async () => {
    try {
      const snap = await getDocs(collection(db, SELLERS_COL));
      const list: SellerCandy[] = [];
      snap.forEach((d) => {
        const data = d.data() as any;
        list.push({
          id: d.id,
          name: data.name || "",
          commissionPercent: Number(data.commissionPercent || 0),
        });
      });
      setSellers(list);
    } catch (e) {
      console.error("Error cargando sellers_candies", e);
    }
  };

  const fetchClosures = async () => {
    const t0 = performance.now();

    try {
      setLoading(true);
      const qy = query(
        collection(db, CLOSURES_COL),
        where("date", ">=", startDate),
        where("date", "<=", endDate),
      );

      const snap = await getDocs(qy);
      const t1 = performance.now();
      console.log("🔥 getDocs ms:", (t1 - t0).toFixed(1), "docs:", snap.size);

      const rows: ClosureDoc[] = [];
      snap.forEach((d) => rows.push({ id: d.id, ...(d.data() as any) }));
      const t2 = performance.now();
      console.log(
        "🧠 parse+set ms:",
        (t2 - t1).toFixed(1),
        "rows:",
        rows.length,
      );
      rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      setClosures(rows);
      setSelected(null);

      // ✅ precarga de ventas reales desde sales_candies (según ids en sales[])
      const ids = new Set<string>();
      rows.forEach((c) => {
        (c.sales || []).forEach((s) => {
          const root = String(s?.id ?? "")
            .split("#")[0]
            .trim();
          if (root) ids.add(root);
        });
      });

      const missing = Array.from(ids).filter((id) => !saleCache[id]);
      if (missing.length > 0) {
        const newCache: Record<string, SaleData[]> = {};
        for (const id of missing) {
          try {
            const snapSale = await getDoc(doc(db, SALES_COL, id));
            if (snapSale.exists()) {
              const raw = snapSale.data() as SaleDataRaw;
              newCache[id] = normalizeMany(raw, id);
            } else {
              newCache[id] = [];
            }
          } catch (e) {
            console.error("Error leyendo sale", id, e);
            newCache[id] = [];
          }
        }
        setSaleCache((prev) => ({ ...prev, ...newCache }));
      }
    } catch (e) {
      console.error(e);
      setMessage("❌ Error cargando liquidaciones.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSellers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchClosures();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyFilter = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetchClosures();
  };

  const sellerNameById = useMemo(() => {
    const map: Record<string, string> = {};
    sellers.forEach((s) => (map[s.id] = s.name || s.id));
    return map;
  }, [sellers]);

  // ===== arma ventas reales por cierre (desde saleCache + ids del cierre) =====
  const getClosureSales = (c: ClosureDoc): SaleData[] => {
    const list: SaleData[] = [];
    (c.sales || []).forEach((s) => {
      const lineId = String(s?.id ?? "").trim(); // docId#idx
      if (!lineId) return;
      const root = lineId.split("#")[0];
      const normalized = saleCache[root] || [];
      const row = normalized.find((x) => x.id === lineId);

      // fallback: si no se encuentra exacto, al menos usa lo que trae el cierre
      if (row) {
        list.push(row);
      } else {
        list.push({
          id: lineId,
          productName: String(s?.productName ?? "(sin nombre)"),
          quantity: Number(s?.quantity ?? 0),
          amount: round2(Number(s?.amount ?? 0)),
          date: String(s?.date ?? ""),
          type: "CONTADO", // no hay data -> default
          vendorId: "",
          userEmail: String(s?.userEmail ?? "(sin vendedor)"),
          vendorCommissionAmount: 0,
        });
      }
    });
    return list;
  };

  // ===== filtro vendedor (por vendorId). Si no hay vendorId, NO se puede filtrar bien. =====
  const filterByVendor = (rows: SaleData[]) => {
    if (vendorFilter === "ALL") return rows;
    return rows.filter((s) => (s.vendorId || "") === vendorFilter);
  };

  // ===== cierres computados (cash/credito + comisiones + paquetes) =====
  const computedClosures = useMemo(() => {
    return closures.map((c) => {
      const sales = filterByVendor(getClosureSales(c));

      let packsCash = 0;
      let packsCredit = 0;
      let amountCash = 0;
      let amountCredit = 0;
      let comCash = 0;
      let comCredit = 0;

      for (const s of sales) {
        const qty = Number(s.quantity || 0);
        const amt = Number(s.amount || 0);
        const com = Number(s.vendorCommissionAmount || 0);

        if (s.type === "CREDITO") {
          packsCredit += qty;
          amountCredit += amt;
          comCredit += com;
        } else {
          packsCash += qty;
          amountCash += amt;
          comCash += com;
        }
      }

      return {
        ...c,
        _sales: sales,
        _packsCash: round3(packsCash),
        _packsCredit: round3(packsCredit),
        _amountCash: round2(amountCash),
        _amountCredit: round2(amountCredit),
        _comCash: round2(comCash),
        _comCredit: round2(comCredit),
      };
    });
  }, [closures, saleCache, vendorFilter]);

  // ===== KPIs globales =====
  const kpis = useMemo(() => {
    let packsCash = 0;
    let packsCredit = 0;
    let amountCash = 0;
    let amountCredit = 0;
    let comCash = 0;
    let comCredit = 0;

    for (const c of computedClosures as any[]) {
      packsCash += Number(c._packsCash || 0);
      packsCredit += Number(c._packsCredit || 0);
      amountCash += Number(c._amountCash || 0);
      amountCredit += Number(c._amountCredit || 0);
      comCash += Number(c._comCash || 0);
      comCredit += Number(c._comCredit || 0);
    }

    return {
      packsCash: round3(packsCash),
      packsCredit: round3(packsCredit),
      totalSales: round2(amountCash + amountCredit),
      amountCash: round2(amountCash),
      amountCredit: round2(amountCredit),
      comCash: round2(comCash),
      comCredit: round2(comCredit),
    };
  }, [computedClosures]);

  // ===== KPI vendedores comisión cash / crédito =====
  const vendorCommissions = useMemo(() => {
    const cash: Record<
      string,
      { vendorId: string; name: string; total: number }
    > = {};
    const credit: Record<
      string,
      { vendorId: string; name: string; total: number }
    > = {};

    for (const c of computedClosures as any[]) {
      const sales: SaleData[] = c._sales || [];
      for (const s of sales) {
        const vid = (s.vendorId || "").trim();
        if (!vid) continue; // si no hay vendorId, no se puede agrupar “bien”
        const name = sellerNameById[vid] || s.userEmail || vid;
        const com = round2(Number(s.vendorCommissionAmount || 0));

        if (s.type === "CREDITO") {
          if (!credit[vid]) credit[vid] = { vendorId: vid, name, total: 0 };
          credit[vid].total = round2(credit[vid].total + com);
        } else {
          if (!cash[vid]) cash[vid] = { vendorId: vid, name, total: 0 };
          cash[vid].total = round2(cash[vid].total + com);
        }
      }
    }

    return {
      cashRows: Object.values(cash)
        .filter((x) => x.total > 0)
        .sort((a, b) => b.total - a.total),
      creditRows: Object.values(credit)
        .filter((x) => x.total > 0)
        .sort((a, b) => b.total - a.total),
    };
  }, [computedClosures, sellerNameById]);

  // ===== vendedores para dropdown (SIN DUPLICADOS) =====
  const vendorOptions = useMemo(() => {
    // solo sellers_candies, sin mezclar labels (así evitamos repetidos)
    return sellers
      .map((s) => ({ id: s.id, label: s.name || s.id }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [sellers]);

  // ===== detalle seleccionado computado =====
  const selectedComputed = useMemo(() => {
    if (!selected) return null;
    return (
      (computedClosures as any[]).find((x) => x.id === selected.id) || null
    );
  }, [selected, computedClosures]);

  const detailSales: SaleData[] = useMemo(() => {
    if (!selectedComputed) return [];
    return selectedComputed._sales || [];
  }, [selectedComputed]);

  const detailKpis = useMemo(() => {
    let packsCash = 0;
    let packsCredit = 0;
    let amountCash = 0;
    let amountCredit = 0;

    for (const s of detailSales) {
      if (s.type === "CREDITO") {
        packsCredit += Number(s.quantity || 0);
        amountCredit += Number(s.amount || 0);
      } else {
        packsCash += Number(s.quantity || 0);
        amountCash += Number(s.amount || 0);
      }
    }

    return {
      packsCash: round3(packsCash),
      packsCredit: round3(packsCredit),
      amountCash: round2(amountCash),
      amountCredit: round2(amountCredit),
    };
  }, [detailSales]);

  const productSummary = useMemo(() => {
    const map: Record<
      string,
      {
        productName: string;
        packsCash: number;
        packsCredit: number;
        amountCash: number;
        amountCredit: number;
        comCash: number;
        comCredit: number;
      }
    > = {};

    for (const s of detailSales) {
      const key = s.productName || "(sin nombre)";
      if (!map[key]) {
        map[key] = {
          productName: key,
          packsCash: 0,
          packsCredit: 0,
          amountCash: 0,
          amountCredit: 0,
          comCash: 0,
          comCredit: 0,
        };
      }

      const qty = Number(s.quantity || 0);
      const amt = Number(s.amount || 0);
      const com = Number(s.vendorCommissionAmount || 0);

      if (s.type === "CREDITO") {
        map[key].packsCredit = round3(map[key].packsCredit + qty);
        map[key].amountCredit = round2(map[key].amountCredit + amt);
        map[key].comCredit = round2(map[key].comCredit + com);
      } else {
        map[key].packsCash = round3(map[key].packsCash + qty);
        map[key].amountCash = round2(map[key].amountCash + amt);
        map[key].comCash = round2(map[key].comCash + com);
      }
    }

    return Object.values(map);
  }, [detailSales]);

  const handleDownloadPDF = async () => {
    if (!detailRef.current || !selectedComputed) return;

    const el = detailRef.current;
    el.classList.add("force-pdf-colors");

    try {
      const canvas = await html2canvas(el, { backgroundColor: "#ffffff" });
      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF();
      pdf.addImage(imgData, "PNG", 10, 10, 190, 0);
      pdf.save(`liquidacion_${selectedComputed.date}.pdf`);
    } finally {
      el.classList.remove("force-pdf-colors");
    }
  };

  return (
    <div className="max-w-7xl mx-auto p-6 bg-white rounded-2xl shadow-2xl">
      <h1 className="text-2xl font-bold mb-4">Liquidaciones</h1>

      {/* filtros */}
      <form
        onSubmit={applyFilter}
        className="flex flex-wrap items-end gap-3 mb-4"
      >
        <div>
          <label className="block text-sm">Desde</label>
          <input
            type="date"
            className="border rounded px-2 py-1"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-sm">Hasta</label>
          <input
            type="date"
            className="border rounded px-2 py-1"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-sm">Vendedor</label>
          <select
            className="border rounded px-2 py-1 min-w-[240px]"
            value={vendorFilter}
            onChange={(e) => setVendorFilter(e.target.value)}
          >
            <option value="ALL">Todos</option>
            {vendorOptions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
        >
          Aplicar
        </button>
      </form>

      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-3 mb-6">
        <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
          <div className="text-xs text-gray-600">Paquetes cash</div>
          <div className="text-2xl font-bold">{qty3(kpis.packsCash)}</div>
        </div>

        <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
          <div className="text-xs text-gray-600">Paquetes crédito</div>
          <div className="text-2xl font-bold">{qty3(kpis.packsCredit)}</div>
        </div>

        <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
          <div className="text-xs text-gray-600">Ventas totales</div>
          <div className="text-2xl font-bold">C${money(kpis.totalSales)}</div>
        </div>

        <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
          <div className="text-xs text-gray-600">Ventas cash</div>
          <div className="text-2xl font-bold">C${money(kpis.amountCash)}</div>
        </div>

        <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
          <div className="text-xs text-gray-600">Ventas crédito</div>
          <div className="text-2xl font-bold">C${money(kpis.amountCredit)}</div>
        </div>

        <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
          <div className="text-xs text-gray-600">Comisión cash</div>
          <div className="text-2xl font-bold">C${money(kpis.comCash)}</div>
        </div>

        <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
          <div className="text-xs text-gray-600">Comisión crédito</div>
          <div className="text-2xl font-bold">C${money(kpis.comCredit)}</div>
        </div>

        <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
          <div className="text-xs text-gray-600">
            Vendedores (comisión cash)
          </div>
          {vendorCommissions.cashRows.length === 0 ? (
            <div className="text-sm text-gray-500 mt-2">—</div>
          ) : (
            <div className="mt-2 space-y-1 max-h-28 overflow-auto pr-1">
              {vendorCommissions.cashRows.map((v) => (
                <div
                  key={v.vendorId}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="truncate">{v.name}</span>
                  <strong className="ml-2">C${money(v.total)}</strong>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
          <div className="text-xs text-gray-600">
            Vendedores (comisión crédito)
          </div>
          {vendorCommissions.creditRows.length === 0 ? (
            <div className="text-sm text-gray-500 mt-2">—</div>
          ) : (
            <div className="mt-2 space-y-1 max-h-28 overflow-auto pr-1">
              {vendorCommissions.creditRows.map((v) => (
                <div
                  key={v.vendorId}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="truncate">{v.name}</span>
                  <strong className="ml-2">C${money(v.total)}</strong>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* tabla principal */}
      {loading ? (
        <p>Cargando...</p>
      ) : computedClosures.length === 0 ? (
        <p className="text-sm text-gray-500">
          Sin cierres en el rango seleccionado.
        </p>
      ) : (
        <table className="min-w-full text-sm mb-6 shadow-lg p-4 bg-white border-gray-100">
          <thead className="bg-gray-100">
            <tr>
              <th className="border p-2">Fecha</th>
              <th className="border p-2">Total paquetes Cash</th>
              <th className="border p-2">Total paquetes crédito</th>
              <th className="border p-2">Total Ventas cash</th>
              <th className="border p-2">Total Ventas crédito</th>
              <th className="border p-2">Comisión cash</th>
              <th className="border p-2">Comisión crédito</th>
              <th className="border p-2">Opciones</th>
            </tr>
          </thead>
          <tbody>
            {(computedClosures as any[]).map((c) => (
              <tr key={c.id} className="text-center">
                <td className="border p-1">{c.date}</td>
                <td className="border p-1">{qty3(c._packsCash)}</td>
                <td className="border p-1">{qty3(c._packsCredit)}</td>
                <td className="border p-1">C${money(c._amountCash)}</td>
                <td className="border p-1">C${money(c._amountCredit)}</td>
                <td className="border p-1">C${money(c._comCash)}</td>
                <td className="border p-1">C${money(c._comCredit)}</td>
                <td className="border p-1">
                  <div className="flex items-center gap-2 justify-center">
                    <button
                      className="text-xs bg-gray-800 text-white px-2 py-1 rounded hover:bg-black"
                      onClick={() => setSelected(c)}
                    >
                      Ver detalle
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* detalle */}
      {selectedComputed && (
        <div className="mt-6 rounded-2xl shadow-lg p-4 bg-white border-solid border-2 border-gray-100">
          <div className="flex items-center gap-3 mb-2 ">
            <h2 className="text-xl font-semibold">
              Detalle {selectedComputed.date}
            </h2>
            <button
              onClick={() => setSelected(null)}
              className="text-sm px-2 py-1 border rounded"
            >
              Cerrar
            </button>
            <button
              onClick={handleDownloadPDF}
              className="ml-auto bg-green-600 text-white px-3 py-1 rounded-2xl hover:bg-green-700 text-sm"
            >
              Descargar PDF
            </button>
          </div>

          <div ref={detailRef} className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
              <div>
                Total Ventas cash:{" "}
                <strong>C${money(detailKpis.amountCash)}</strong>
              </div>
              <div>
                Total Ventas crédito:{" "}
                <strong>C${money(detailKpis.amountCredit)}</strong>
              </div>
              <div>
                Total paquetes cash:{" "}
                <strong>{qty3(detailKpis.packsCash)}</strong>
              </div>
              <div>
                Total paquetes crédito:{" "}
                <strong>{qty3(detailKpis.packsCredit)}</strong>
              </div>
            </div>

            <h3 className="font-semibold">Ventas incluidas en el cierre</h3>

            {detailSales.length === 0 ? (
              <p className="text-sm text-gray-500">
                Sin ventas en este cierre.
              </p>
            ) : (
              <table className="min-w-full border text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="border p-2">Vendedor</th>
                    <th className="border p-2">Producto</th>
                    <th className="border p-2">Tipo</th>
                    <th className="border p-2">Paquetes</th>
                    <th className="border p-2">Monto</th>
                    <th className="border p-2">Comisión</th>
                    <th className="border p-2">Fecha venta</th>
                  </tr>
                </thead>
                <tbody>
                  {detailSales.map((s, i) => {
                    const vendorName =
                      s.vendorId && sellerNameById[s.vendorId]
                        ? sellerNameById[s.vendorId]
                        : s.userEmail;

                    const com = round2(Number(s.vendorCommissionAmount || 0));

                    return (
                      <tr key={i} className="text-center">
                        <td className="border p-1">{vendorName}</td>
                        <td className="border p-1">{s.productName}</td>
                        <td className="border p-1">
                          {s.type === "CREDITO" ? "Crédito" : "Cash"}
                        </td>
                        <td className="border p-1">{qty3(s.quantity)}</td>
                        <td className="border p-1">C${money(s.amount)}</td>
                        <td className="border p-1">
                          {com > 0 ? `C$${money(com)}` : "—"}
                        </td>
                        <td className="border p-1">{s.date || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            <h3 className="font-semibold">Consolidado por producto</h3>

            {productSummary.length === 0 ? (
              <p className="text-sm text-gray-500">
                Sin datos para consolidar.
              </p>
            ) : (
              <table className="min-w-full border text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="border p-2">Producto</th>
                    <th className="border p-2">Total paquetes cash</th>
                    <th className="border p-2">Total paquetes crédito</th>
                    <th className="border p-2">Ventas cash</th>
                    <th className="border p-2">Ventas crédito</th>
                    <th className="border p-2">Comisión cash</th>
                    <th className="border p-2">Comisión crédito</th>
                  </tr>
                </thead>
                <tbody>
                  {productSummary.map((r, i) => (
                    <tr key={i} className="text-center">
                      <td className="border p-1">{r.productName}</td>
                      <td className="border p-1">{qty3(r.packsCash)}</td>
                      <td className="border p-1">{qty3(r.packsCredit)}</td>
                      <td className="border p-1">C${money(r.amountCash)}</td>
                      <td className="border p-1">C${money(r.amountCredit)}</td>
                      <td className="border p-1">C${money(r.comCash)}</td>
                      <td className="border p-1">C${money(r.comCredit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {message && <p className="mt-3 text-sm">{message}</p>}
    </div>
  );
}
