// src/components/Candies/ConsolidadoVendedoresDulces.tsx
import React, { useEffect, useMemo, useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../../firebase";

type Branch = "RIVAS" | "SAN_JORGE" | "ISLA";

interface Seller {
  id: string;
  name: string;
  branch: Branch;
  branchLabel: string;
  commissionPercent: number;
}

interface Product {
  id: string;
  name: string;
}

interface SaleDoc {
  id: string;
  date: string; // yyyy-MM-dd
  type: "CONTADO" | "CREDITO" | string;
  vendorId?: string;
  sellerId?: string; // compat
  vendorName?: string;
  vendorBranch?: Branch;
  vendorBranchLabel?: string;
  vendorCommissionPercent?: number;
  vendorCommissionAmount?: number; // (legacy) comisión total guardada
  total?: number;
  itemsTotal?: number;
  packagesTotal?: number;
  quantity?: number;
  items?: {
    productId: string;
    productName: string;
    packages?: number;
    qty?: number;
    quantity?: number;
    unitsPerPackage?: number;
    units?: number;
    unitPricePackage?: number;
    unitPrice?: number;
    discount?: number;
    total?: number; // (legacy) a veces viene bruto, a veces neto
    vendorCommissionAmount?: number; // si alguna vez lo guardaste por item
  }[];
}

type MetricKey = "ordered" | "remaining" | "sold" | "credit";

interface DrilldownRow {
  date: string;
  vendorName: string;
  productName: string;
  packages: number;
  totalMoney: number; // NETO (lineFinal)
  vendorCommission: number;
}

interface VendorSummary {
  vendorId: string;
  vendorName: string;
  branchLabel: string;
  orderedPackages: number;
  remainingPackages: number;
  soldPackages: number; // CASH
  creditPackages: number; // CREDITO
  totalSoldMoney: number; // CASH neto
  totalCreditMoney: number; // CREDITO neto
  ordersCreated: number;
  commissionCash: number;
  commissionCredit: number; // SIEMPRE 0 (alineado)
}

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

function branchLabel(branch: Branch | undefined): string {
  if (!branch) return "";
  switch (branch) {
    case "RIVAS":
      return "Rivas";
    case "SAN_JORGE":
      return "San Jorge";
    case "ISLA":
      return "Isla de Ometepe";
    default:
      return "";
  }
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function getDefaultFrom(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
    2,
    "0"
  )}-01`;
}

function getDefaultTo(): string {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const lastDay = new Date(nextMonth.getTime() - 24 * 60 * 60 * 1000);
  return formatDate(lastDay);
}

export default function ConsolidadoVendedoresDulces() {
  const [dateFrom, setDateFrom] = useState<string>(getDefaultFrom());
  const [dateTo, setDateTo] = useState<string>(getDefaultTo());

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string>("");

  const [sellers, setSellers] = useState<Record<string, Seller>>({});
  const [products, setProducts] = useState<Record<string, Product>>({});

  const [vendorSummary, setVendorSummary] = useState<VendorSummary[]>([]);
  const [topProducts, setTopProducts] = useState<
    { productName: string; packages: number; totalMoney: number }[]
  >([]);

  const [drilldownData, setDrilldownData] = useState<
    Record<string, Record<MetricKey, DrilldownRow[]>>
  >({});

  const [modalOpen, setModalOpen] = useState(false);
  const [modalVendorId, setModalVendorId] = useState<string | null>(null);
  const [modalMetric, setModalMetric] = useState<MetricKey | null>(null);

  const selectedVendor = useMemo(() => {
    if (!modalVendorId) return null;
    return vendorSummary.find((v) => v.vendorId === modalVendorId) || null;
  }, [modalVendorId, vendorSummary]);

  const modalRows: DrilldownRow[] = useMemo(() => {
    if (!modalVendorId || !modalMetric) return [];
    return drilldownData[modalVendorId]?.[modalMetric] || [];
  }, [modalVendorId, modalMetric, drilldownData]);

  const totalMoneySoldAll = useMemo(
    () =>
      round2(
        vendorSummary.reduce((sum, v) => sum + (v.totalSoldMoney || 0), 0)
      ),
    [vendorSummary]
  );

  const totalMoneyCreditAll = useMemo(
    () =>
      round2(
        vendorSummary.reduce((sum, v) => sum + (v.totalCreditMoney || 0), 0)
      ),
    [vendorSummary]
  );

  useEffect(() => {
    (async () => {
      try {
        const vSnap = await getDocs(collection(db, "sellers_candies"));
        const sellersMap: Record<string, Seller> = {};
        vSnap.forEach((d) => {
          const x = d.data() as any;
          const rawBranch: string = x.branch || "Rivas";
          let normalized: Branch = "RIVAS";
          if (rawBranch === "San Jorge") normalized = "SAN_JORGE";
          else if (rawBranch === "Isla Ometepe") normalized = "ISLA";
          sellersMap[d.id] = {
            id: d.id,
            name: x.name ?? "(sin nombre)",
            branch: normalized,
            branchLabel: rawBranch,
            commissionPercent: Number(x.commissionPercent ?? 0),
          };
        });

        const pSnap = await getDocs(collection(db, "products_candies"));
        const productsMap: Record<string, Product> = {};
        pSnap.forEach((d) => {
          const x = d.data() as any;
          productsMap[d.id] = { id: d.id, name: x.name ?? "(sin nombre)" };
        });

        setSellers(sellersMap);
        setProducts(productsMap);
      } catch (e) {
        console.error(e);
        setMessage("❌ Error cargando catálogos de vendedores/productos.");
      }
    })();
  }, []);

  const loadData = async () => {
    if (!dateFrom || !dateTo) {
      setMessage("Selecciona rango de fechas válido.");
      return;
    }

    if (!Object.keys(sellers).length) {
      setMessage("Cargando vendedores, intenta de nuevo en unos segundos.");
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      // ====== MAPS LOCALES (NO afuera) ======
      const commissionCashByVendor: Record<string, number> = {};
      const commissionCreditByVendor: Record<string, number> = {}; // quedará 0

      /* --------------------------------- PEDIDOS (inventory_candies_sellers) --------------------------------- */
      const qInv = query(
        collection(db, "inventory_candies_sellers"),
        where("date", ">=", dateFrom),
        where("date", "<=", dateTo)
      );
      const invSnap = await getDocs(qInv);

      const orderedPackagesByVendor: Record<string, number> = {};
      const remainingPackagesByVendor: Record<string, number> = {};

      const ordersKeysByVendor: Record<string, Set<string>> = {};
      const invDrill: Record<
        string,
        { ordered: DrilldownRow[]; remaining: DrilldownRow[] }
      > = {};

      invSnap.forEach((d) => {
        const x = d.data() as any;
        const sellerId = x.sellerId || "";
        if (!sellerId) return;

        const productId = x.productId || "";
        const productName =
          x.productName || products[productId]?.name || "(sin nombre)";

        const unitsPerPackage = Math.max(
          1,
          Math.floor(Number(x.unitsPerPackage || 1))
        );
        const totalUnits = Number(x.totalUnits ?? 0);
        const packagesField = Number(x.packages ?? 0);
        const remainingUnits = Number(x.remainingUnits ?? x.remaining ?? 0);
        const remainingPackagesField = Number(x.remainingPackages ?? 0);

        const packagesOrdered =
          packagesField > 0
            ? packagesField
            : totalUnits > 0
            ? Math.floor(totalUnits / unitsPerPackage)
            : 0;

        const remainingPacks =
          remainingPackagesField > 0
            ? remainingPackagesField
            : remainingUnits > 0
            ? Math.floor(remainingUnits / unitsPerPackage)
            : 0;

        orderedPackagesByVendor[sellerId] =
          (orderedPackagesByVendor[sellerId] || 0) + packagesOrdered;

        remainingPackagesByVendor[sellerId] =
          (remainingPackagesByVendor[sellerId] || 0) + remainingPacks;

        const orderKey: string =
          x.orderId || x.vendorOrderId || x.orderNumber || x.order || d.id;
        if (!ordersKeysByVendor[sellerId])
          ordersKeysByVendor[sellerId] = new Set<string>();
        ordersKeysByVendor[sellerId].add(orderKey);

        const sellerName =
          sellers[sellerId]?.name || x.sellerName || "(sin vendedor)";
        const dateStr = String(x.date || "");

        const totalVendorDoc = Number(x.totalVendor ?? 0);
        const gainVendorDoc = Number(x.gainVendor ?? 0);
        const originalPackages =
          packagesField > 0
            ? packagesField
            : totalUnits > 0
            ? Math.floor(totalUnits / unitsPerPackage)
            : 0;

        const moneyPerPackage =
          originalPackages > 0 ? totalVendorDoc / originalPackages : 0;
        const commissionPerPackage =
          originalPackages > 0 ? gainVendorDoc / originalPackages : 0;

        const orderedMoney = round2(packagesOrdered * moneyPerPackage);
        const orderedCommission = round2(
          packagesOrdered * commissionPerPackage
        );
        const remainingMoney = round2(remainingPacks * moneyPerPackage);
        const remainingCommission = round2(
          remainingPacks * commissionPerPackage
        );

        if (!invDrill[sellerId])
          invDrill[sellerId] = { ordered: [], remaining: [] };

        if (packagesOrdered > 0) {
          invDrill[sellerId].ordered.push({
            date: dateStr,
            vendorName: sellerName,
            productName,
            packages: packagesOrdered,
            totalMoney: orderedMoney,
            vendorCommission: orderedCommission,
          });
        }

        if (remainingPacks > 0) {
          invDrill[sellerId].remaining.push({
            date: dateStr,
            vendorName: sellerName,
            productName,
            packages: remainingPacks,
            totalMoney: remainingMoney,
            vendorCommission: remainingCommission,
          });
        }
      });

      const ordersCountByVendor: Record<string, number> = {};
      Object.keys(ordersKeysByVendor).forEach((vendorId) => {
        ordersCountByVendor[vendorId] = ordersKeysByVendor[vendorId].size;
      });

      /* --------------------------------- VENTAS (sales_candies) --------------------------------- */
      const qSales = query(
        collection(db, "sales_candies"),
        where("date", ">=", dateFrom),
        where("date", "<=", dateTo)
      );
      const salesSnap = await getDocs(qSales);

      const soldPackagesByVendor: Record<string, number> = {};
      const creditPackagesByVendor: Record<string, number> = {};
      const totalSoldMoneyByVendor: Record<string, number> = {};
      const totalCreditMoneyByVendor: Record<string, number> = {};

      const salesDrill: Record<
        string,
        { sold: DrilldownRow[]; credit: DrilldownRow[] }
      > = {};
      const productAgg: Record<
        string,
        { productName: string; packages: number; totalMoney: number }
      > = {};

      salesSnap.forEach((d) => {
        const raw = d.data() as any as SaleDoc;

        const saleDate = raw.date || "";
        const vendorId = raw.vendorId || raw.sellerId || "";
        if (!vendorId) return;

        const seller = sellers[vendorId];
        const vendorName = raw.vendorName || seller?.name || "(sin vendedor)";
        const commissionPercent =
          Number(
            raw.vendorCommissionPercent ?? seller?.commissionPercent ?? 0
          ) || 0;

        const items = Array.isArray(raw.items) ? raw.items : [];
        if (!items.length) return;

        const isCredit = String(raw.type || "").toUpperCase() === "CREDITO";

        if (!salesDrill[vendorId])
          salesDrill[vendorId] = { sold: [], credit: [] };

        items.forEach((it) => {
          const pName =
            it.productName ||
            products[it.productId || ""]?.name ||
            "(sin nombre)";

          const packsRaw = it.packages ?? it.qty ?? it.quantity ?? 0;
          const packages = Number(packsRaw || 0);
          if (packages <= 0) return;

          const unitPrice =
            Number(it.unitPricePackage ?? it.unitPrice ?? 0) || 0;
          const discount = Math.max(0, Number(it.discount || 0));

          // ✅ lineFinal NETO (alineado con Dashboard)
          const lineTotal = packages * unitPrice;
          const lineFinal = round2(Math.max(0, lineTotal - discount));
          if (lineFinal <= 0) return;

          // ✅ comisión por línea: Cash sí, Crédito NO
          let lineCommission = 0;
          if (!isCredit) {
            // si guardaste por item, lo respeta
            const storedItemCommission = Number(
              (it as any).vendorCommissionAmount ?? 0
            );
            if (storedItemCommission)
              lineCommission = round2(storedItemCommission);
            else if (commissionPercent > 0)
              lineCommission = round2((lineFinal * commissionPercent) / 100);
          } else {
            lineCommission = 0;
          }

          // ✅ acumulados por vendedor: CASH vs CRÉDITO
          if (isCredit) {
            creditPackagesByVendor[vendorId] =
              (creditPackagesByVendor[vendorId] || 0) + packages;
            totalCreditMoneyByVendor[vendorId] =
              (totalCreditMoneyByVendor[vendorId] || 0) + lineFinal;
          } else {
            soldPackagesByVendor[vendorId] =
              (soldPackagesByVendor[vendorId] || 0) + packages;
            totalSoldMoneyByVendor[vendorId] =
              (totalSoldMoneyByVendor[vendorId] || 0) + lineFinal;
          }

          // ✅ comisiones separadas (crédito queda 0)
          if (!isCredit) {
            commissionCashByVendor[vendorId] =
              (commissionCashByVendor[vendorId] || 0) + lineCommission;
          } else {
            commissionCreditByVendor[vendorId] =
              (commissionCreditByVendor[vendorId] || 0) + 0;
          }

          // ✅ drilldown
          if (!isCredit) {
            salesDrill[vendorId].sold.push({
              date: saleDate,
              vendorName,
              productName: pName,
              packages,
              totalMoney: lineFinal,
              vendorCommission: lineCommission,
            });
          } else {
            salesDrill[vendorId].credit.push({
              date: saleDate,
              vendorName,
              productName: pName,
              packages,
              totalMoney: lineFinal,
              vendorCommission: 0,
            });
          }

          // ✅ top productos (sumo cash+crédito, neto)
          const key = pName;
          if (!productAgg[key])
            productAgg[key] = {
              productName: pName,
              packages: 0,
              totalMoney: 0,
            };
          productAgg[key].packages += packages;
          productAgg[key].totalMoney += lineFinal;
        });
      });

      /* --------------------------------- CONSOLIDADO POR VENDEDOR --------------------------------- */
      const allVendorIds = new Set<string>([
        ...Object.keys(orderedPackagesByVendor),
        ...Object.keys(remainingPackagesByVendor),
        ...Object.keys(soldPackagesByVendor),
        ...Object.keys(creditPackagesByVendor),
      ]);

      const summaries: VendorSummary[] = [];
      const fullDrill: Record<string, Record<MetricKey, DrilldownRow[]>> = {};

      allVendorIds.forEach((vendorId) => {
        const s = sellers[vendorId];
        const vendorName = s?.name || "(sin vendedor)";
        const branchLbl = s ? s.branchLabel || branchLabel(s.branch) : "—";

        const orderedPackages = orderedPackagesByVendor[vendorId] || 0;
        const remainingPackages = remainingPackagesByVendor[vendorId] || 0;
        const soldPackages = soldPackagesByVendor[vendorId] || 0;
        const creditPackages = creditPackagesByVendor[vendorId] || 0;

        const totalSoldMoney = round2(totalSoldMoneyByVendor[vendorId] || 0);
        const totalCreditMoney = round2(
          totalCreditMoneyByVendor[vendorId] || 0
        );
        const ordersCreated = ordersCountByVendor[vendorId] || 0;

        summaries.push({
          vendorId,
          vendorName,
          branchLabel: branchLbl,
          orderedPackages,
          remainingPackages,
          soldPackages,
          creditPackages,
          totalSoldMoney,
          totalCreditMoney,
          ordersCreated,
          commissionCash: round2(commissionCashByVendor[vendorId] || 0),
          commissionCredit: 0, // ✅ alineado: crédito NO paga comisión
        });

        fullDrill[vendorId] = {
          ordered: (invDrill[vendorId]?.ordered || []).sort((a, b) =>
            a.date.localeCompare(b.date)
          ),
          remaining: (invDrill[vendorId]?.remaining || []).sort((a, b) =>
            a.date.localeCompare(b.date)
          ),
          sold: (salesDrill[vendorId]?.sold || []).sort((a, b) =>
            a.date.localeCompare(b.date)
          ),
          credit: (salesDrill[vendorId]?.credit || []).sort((a, b) =>
            a.date.localeCompare(b.date)
          ),
        };
      });

      summaries.sort((a, b) => a.vendorName.localeCompare(b.vendorName, "es"));

      setVendorSummary(summaries);
      setDrilldownData(fullDrill);

      const topArray = Object.values(productAgg)
        .map((p) => ({
          productName: p.productName,
          packages: p.packages,
          totalMoney: round2(p.totalMoney),
        }))
        .sort((a, b) => b.packages - a.packages)
        .slice(0, 10);

      setTopProducts(topArray);

      if (!summaries.length)
        setMessage("Sin datos para el rango seleccionado.");
    } catch (e) {
      console.error(e);
      setMessage("❌ Error cargando consolidado de vendedores.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (Object.keys(sellers).length) {
      loadData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sellers]);

  const openDrilldown = (vendorId: string, metric: MetricKey) => {
    setModalVendorId(vendorId);
    setModalMetric(metric);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setModalVendorId(null);
    setModalMetric(null);
  };

  const handleExportCSV = () => {
    if (!vendorSummary.length) {
      setMessage("No hay datos para exportar.");
      return;
    }

    const header = [
      "Vendedor",
      "Sucursal",
      "Paquetes ordenados",
      "Paquetes restantes",
      "Paquetes vendidos",
      "Paquetes fiados",
      "Total vendidos (C$)",
      "Comisión Cash (C$)",
      "Total fiado (C$)",
      "Comisión Crédito (C$)",
      "Órdenes creadas",
    ];

    const rows = vendorSummary.map((v) => [
      v.vendorName,
      v.branchLabel,
      v.orderedPackages.toString(),
      v.remainingPackages.toString(),
      v.soldPackages.toString(),
      v.creditPackages.toString(),
      v.totalSoldMoney.toFixed(2),
      v.commissionCash.toFixed(2),
      v.totalCreditMoney.toFixed(2),
      v.commissionCredit.toFixed(2),
      v.ordersCreated.toString(),
    ]);

    const csvContent = [header, ...rows]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `consolidado_vendedores_dulces_${dateFrom}_a_${dateTo}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-7xl mx-auto bg-white p-6 rounded-2xl shadow-2xl">
      <h2 className="text-2xl font-bold mb-4">
        Consolidado por Vendedor - Dulces
      </h2>

      {/* Filtros de fecha */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4 text-sm">
        <div>
          <label className="block font-semibold mb-1">Desde</label>
          <input
            type="date"
            className="w-full border rounded px-2 py-1"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </div>
        <div>
          <label className="block font-semibold mb-1">Hasta</label>
          <input
            type="date"
            className="w-full border rounded px-2 py-1"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </div>
        <div className="flex items-end">
          <button
            type="button"
            onClick={loadData}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 w-full"
            disabled={loading}
          >
            {loading ? "Cargando..." : "Aplicar filtros"}
          </button>
        </div>
        <div className="flex items-end">
          <button
            type="button"
            onClick={handleExportCSV}
            className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 w-full"
          >
            Exportar CSV
          </button>
        </div>
      </div>

      {/* KPIs de dinero */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6 text-sm">
        <div className="border rounded-lg p-3 bg-gray-50">
          <div className="text-xs text-gray-500">Dinero total vendido</div>
          <div className="text-xl font-semibold">
            {money(totalMoneySoldAll)}
          </div>
        </div>
        <div className="border rounded-lg p-3 bg-gray-50">
          <div className="text-xs text-gray-500">Dinero total fiado</div>
          <div className="text-xl font-semibold">
            {money(totalMoneyCreditAll)}
          </div>
        </div>
        <div className="border rounded-lg p-3 bg-gray-50">
          <div className="text-xs text-gray-500">Vendedores con movimiento</div>
          <div className="text-xl font-semibold">{vendorSummary.length}</div>
        </div>
      </div>

      {/* Tabla por vendedor */}
      <div className="overflow-x-auto mb-6">
        <table className="min-w-full border text-sm shadow-2xl">
          <thead className="bg-gray-100">
            <tr>
              <th className="border p-2">Vendedor</th>
              <th className="border p-2">Sucursal</th>
              <th className="border p-2">Paquetes ordenados</th>
              <th className="border p-2">Paquetes restantes</th>
              <th className="border p-2">Paquetes vendidos</th>
              <th className="border p-2">Paquetes fiados</th>
              <th className="border p-2">Total vendidos (C$)</th>
              <th className="border p-2">Comisión Cash (C$)</th>
              <th className="border p-2">Total fiado (C$)</th>
              <th className="border p-2">Comisión Crédito (C$)</th>
              <th className="border p-2">Órdenes creadas</th>
            </tr>
          </thead>
          <tbody>
            {vendorSummary.map((v) => (
              <tr key={v.vendorId} className="text-center">
                <td className="border p-1">{v.vendorName}</td>
                <td className="border p-1">{v.branchLabel}</td>
                <td className="border p-1">
                  <button
                    type="button"
                    className="text-blue-600 underline"
                    onClick={() => openDrilldown(v.vendorId, "ordered")}
                  >
                    {v.orderedPackages}
                  </button>
                </td>
                <td className="border p-1">
                  <button
                    type="button"
                    className="text-blue-600 underline"
                    onClick={() => openDrilldown(v.vendorId, "remaining")}
                  >
                    {v.remainingPackages}
                  </button>
                </td>
                <td className="border p-1">
                  <button
                    type="button"
                    className="text-blue-600 underline"
                    onClick={() => openDrilldown(v.vendorId, "sold")}
                  >
                    {v.soldPackages}
                  </button>
                </td>
                <td className="border p-1">
                  <button
                    type="button"
                    className="text-blue-600 underline"
                    onClick={() => openDrilldown(v.vendorId, "credit")}
                  >
                    {v.creditPackages}
                  </button>
                </td>
                <td className="border p-1">{money(v.totalSoldMoney)}</td>
                <td className="border p-1">{money(v.commissionCash)}</td>
                <td className="border p-1">{money(v.totalCreditMoney)}</td>
                <td className="border p-1">{money(v.commissionCredit)}</td>
                <td className="border p-1">{v.ordersCreated}</td>
              </tr>
            ))}
            {vendorSummary.length === 0 && !loading && (
              <tr>
                <td colSpan={11} className="p-3 text-center text-gray-500">
                  Sin datos para mostrar.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Top 10 productos */}
      <div className="mb-6">
        <h3 className="font-semibold mb-2 text-sm">
          Top 10 productos más vendidos (paquetes)
        </h3>
        <div className="overflow-x-auto">
          <table className="min-w-full border text-xs shadow-2xl">
            <thead className="bg-gray-100">
              <tr>
                <th className="border p-2">#</th>
                <th className="border p-2">Producto</th>
                <th className="border p-2">Paquetes vendidos</th>
                <th className="border p-2">Total dinero (C$)</th>
              </tr>
            </thead>
            <tbody>
              {topProducts.map((p, idx) => (
                <tr key={p.productName} className="text-center">
                  <td className="border p-1">{idx + 1}</td>
                  <td className="border p-1">{p.productName}</td>
                  <td className="border p-1">{p.packages}</td>
                  <td className="border p-1">{money(p.totalMoney)}</td>
                </tr>
              ))}
              {topProducts.length === 0 && !loading && (
                <tr>
                  <td colSpan={4} className="p-3 text-center text-gray-500">
                    Sin productos para mostrar.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {message && <p className="mt-2 text-sm text-gray-700">{message}</p>}

      {/* Modal drilldown */}
      {modalOpen && modalMetric && modalVendorId && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-[95%] max-w-4xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <div>
                <h4 className="font-semibold text-lg">
                  Detalle{" "}
                  {modalMetric === "ordered"
                    ? "Paquetes ordenados"
                    : modalMetric === "remaining"
                    ? "Paquetes restantes"
                    : modalMetric === "sold"
                    ? "Paquetes vendidos"
                    : "Paquetes fiados"}
                </h4>
                <p className="text-xs text-gray-500">
                  {selectedVendor?.vendorName} — {selectedVendor?.branchLabel}
                </p>
              </div>
              <button
                onClick={closeModal}
                className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300 text-sm"
              >
                Cerrar
              </button>
            </div>

            <div className="flex-1 overflow-auto p-4">
              <table className="min-w-full border text-xs">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="border p-2">Fecha</th>
                    <th className="border p-2">Producto</th>
                    <th className="border p-2">Paquetes</th>
                    <th className="border p-2">Total dinero (C$)</th>
                    <th className="border p-2">Vendedor</th>
                    <th className="border p-2">Comisión vendedor (C$)</th>
                  </tr>
                </thead>
                <tbody>
                  {modalRows.map((r, idx) => (
                    <tr key={idx} className="text-center">
                      <td className="border p-1">{r.date}</td>
                      <td className="border p-1">{r.productName}</td>
                      <td className="border p-1">{r.packages}</td>
                      <td className="border p-1">{money(r.totalMoney)}</td>
                      <td className="border p-1">{r.vendorName}</td>
                      <td className="border p-1">
                        {money(r.vendorCommission)}
                      </td>
                    </tr>
                  ))}
                  {modalRows.length === 0 && (
                    <tr>
                      <td colSpan={6} className="p-3 text-center text-gray-500">
                        Sin registros para mostrar.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
