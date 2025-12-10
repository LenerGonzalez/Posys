import React, { useEffect, useMemo, useState } from "react";
import { collection, getDocs, query, where, doc } from "firebase/firestore";
import { db } from "../../firebase";

type Branch = "RIVAS" | "SAN_JORGE" | "ISLA";

interface Seller {
  id: string;
  name: string;
  branch: Branch;
  branchLabel: string;
  commissionPercent: number;
}

interface SellerInventoryDoc {
  id: string;
  sellerId: string;
  productId: string;
  date: string; // yyyy-MM-dd
  packages: number; // paquetes ordenados (campo packages, si no lo calculamos)
  remainingPackages: number; // paquetes restantes
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
  vendorName?: string;
  vendorBranch?: Branch;
  vendorBranchLabel?: string;
  vendorCommissionPercent?: number;
  vendorCommissionAmount?: number;
  total?: number;
  items?: {
    productId: string;
    productName: string;
    packages?: number;
    qty?: number;
    quantity?: number;
    unitsPerPackage?: number;
    unitPricePackage?: number;
    discount?: number;
    total?: number;
  }[];
}

type MetricKey = "ordered" | "remaining" | "sold" | "credit";

interface DrilldownRow {
  date: string;
  vendorName: string;
  productName: string;
  packages: number;
  totalMoney: number;
  vendorCommission: number;
}

interface VendorSummary {
  vendorId: string;
  vendorName: string;
  branchLabel: string;
  orderedPackages: number;
  remainingPackages: number;
  soldPackages: number;
  creditPackages: number;
  totalSoldMoney: number;
  totalCreditMoney: number;
  ordersCreated: number;
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

// Devuelve yyyy-MM-dd
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Primer día de mes actual
function getDefaultFrom(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
    2,
    "0"
  )}-01`;
}

// Último día de mes actual (rápido: sumar 1 mes, día 1, restar 1 día)
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

  // drilldownData[vendorId][metricKey] = DrilldownRow[]
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

  // Cargar catálogos básicos (vendedores y productos) una sola vez
  useEffect(() => {
    (async () => {
      try {
        // sellers_candies
        const vSnap = await getDocs(collection(db, "sellers_candies"));
        const sellersMap: Record<string, Seller> = {};
        vSnap.forEach((d) => {
          const x = d.data() as any;
          const rawBranch: string = x.branch || "Rivas";
          // Reutilizamos la misma lógica que en SalesCandiesPOS
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

        // products_candies
        const pSnap = await getDocs(collection(db, "products_candies"));
        const productsMap: Record<string, Product> = {};
        pSnap.forEach((d) => {
          const x = d.data() as any;
          productsMap[d.id] = {
            id: d.id,
            name: x.name ?? "(sin nombre)",
          };
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

    setLoading(true);
    setMessage("");

    try {
      /* --------------------------------- PEDIDOS (inventory_candies_sellers) --------------------------------- */
      const qInv = query(
        collection(db, "inventory_candies_sellers"),
        where("date", ">=", dateFrom),
        where("date", "<=", dateTo)
      );
      const invSnap = await getDocs(qInv);

      // Por vendedor
      const orderedPackagesByVendor: Record<string, number> = {};
      const remainingPackagesByVendor: Record<string, number> = {};
      const ordersCountByVendor: Record<string, number> = {};

      // drilldown para pedidos/stock
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

        // órdenes creadas (una por doc en rango)
        ordersCountByVendor[sellerId] =
          (ordersCountByVendor[sellerId] || 0) + 1;

        const sellerName = sellers[sellerId]?.name || "(sin vendedor)";
        const dateStr = String(x.date || "");

        if (!invDrill[sellerId]) {
          invDrill[sellerId] = {
            ordered: [],
            remaining: [],
          };
        }

        // Para "paquetes ordenados"
        if (packagesOrdered > 0) {
          invDrill[sellerId].ordered.push({
            date: dateStr,
            vendorName: sellerName,
            productName,
            packages: packagesOrdered,
            totalMoney: 0, // aquí no hay dinero real (es pedido)
            vendorCommission: 0,
          });
        }

        // Para "paquetes restantes"
        if (remainingPacks > 0) {
          invDrill[sellerId].remaining.push({
            date: dateStr,
            vendorName: sellerName,
            productName,
            packages: remainingPacks,
            totalMoney: 0, // stock, sin venta
            vendorCommission: 0,
          });
        }
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

      // drilldown ventas (sold/credit)
      const salesDrill: Record<
        string,
        { sold: DrilldownRow[]; credit: DrilldownRow[] }
      > = {};

      // top productos (global)
      const productAgg: Record<
        string,
        { productName: string; packages: number; totalMoney: number }
      > = {};

      salesSnap.forEach((d) => {
        const x = d.data() as any as SaleDoc;
        const saleId = d.id;
        const saleDate = x.date || "";
        const vendorId = x.vendorId || "";
        if (!vendorId) return; // sin vendedor, lo ignoramos

        const vendorName =
          x.vendorName || sellers[vendorId]?.name || "(sin vendedor)";
        const commissionPercent = Number(
          x.vendorCommissionPercent ?? sellers[vendorId]?.commissionPercent ?? 0
        );
        const commissionTotal = Number(x.vendorCommissionAmount ?? 0);
        const saleTotal = Number(x.total ?? 0);
        const isCredit = String(x.type || "").toUpperCase() === "CREDITO";

        if (!salesDrill[vendorId]) {
          salesDrill[vendorId] = {
            sold: [],
            credit: [],
          };
        }

        const items = Array.isArray(x.items) ? x.items : [];
        if (!items.length) return;

        items.forEach((it) => {
          const productName =
            it.productName ||
            products[it.productId || ""]?.name ||
            "(sin nombre)";

          const packagesRaw = it.packages ?? it.qty ?? it.quantity ?? 0;
          const packages = Number(packagesRaw || 0);

          const lineTotal = Number(it.total ?? 0);
          if (packages <= 0 || lineTotal <= 0) return;

          // agregados por vendedor
          soldPackagesByVendor[vendorId] =
            (soldPackagesByVendor[vendorId] || 0) + packages;
          totalSoldMoneyByVendor[vendorId] =
            (totalSoldMoneyByVendor[vendorId] || 0) + lineTotal;

          if (isCredit) {
            creditPackagesByVendor[vendorId] =
              (creditPackagesByVendor[vendorId] || 0) + packages;
            totalCreditMoneyByVendor[vendorId] =
              (totalCreditMoneyByVendor[vendorId] || 0) + lineTotal;
          }

          // comisión prorrateada por línea (según % de la venta total)
          let lineCommission = 0;
          if (saleTotal > 0 && commissionTotal > 0) {
            const ratio = lineTotal / saleTotal;
            lineCommission = round2(commissionTotal * ratio);
          }

          // drilldown "vendidos"
          salesDrill[vendorId].sold.push({
            date: saleDate,
            vendorName,
            productName,
            packages,
            totalMoney: lineTotal,
            vendorCommission: lineCommission,
          });

          // drilldown "fiados"
          if (isCredit) {
            salesDrill[vendorId].credit.push({
              date: saleDate,
              vendorName,
              productName,
              packages,
              totalMoney: lineTotal,
              vendorCommission: lineCommission,
            });
          }

          // top productos (global)
          const key = productName;
          if (!productAgg[key]) {
            productAgg[key] = {
              productName: productName,
              packages: 0,
              totalMoney: 0,
            };
          }
          productAgg[key].packages += packages;
          productAgg[key].totalMoney += lineTotal;
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
        const branchLbl =
          s?.branchLabel || branchLabel(s?.branch || "RIVAS") || "";

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
        });

        fullDrill[vendorId] = {
          ordered: invDrill[vendorId]?.ordered || [],
          remaining: invDrill[vendorId]?.remaining || [],
          sold: salesDrill[vendorId]?.sold || [],
          credit: salesDrill[vendorId]?.credit || [],
        };
      });

      // ordenar por nombre de vendedor
      summaries.sort((a, b) => a.vendorName.localeCompare(b.vendorName, "es"));

      setVendorSummary(summaries);
      setDrilldownData(fullDrill);

      // top 10 productos
      const topArray = Object.values(productAgg)
        .sort((a, b) => b.packages - a.packages)
        .slice(0, 10);
      setTopProducts(topArray);

      if (!summaries.length) {
        setMessage("Sin datos para el rango seleccionado.");
      }
    } catch (e) {
      console.error(e);
      setMessage("❌ Error cargando consolidado de vendedores.");
    } finally {
      setLoading(false);
    }
  };

  // carga inicial
  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      "Total fiado (C$)",
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
      v.totalCreditMoney.toFixed(2),
      v.ordersCreated.toString(),
    ]);

    const csvContent = [header, ...rows]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csvContent], {
      type: "text/csv;charset=utf-8;",
    });
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
              <th className="border p-2">Total fiado (C$)</th>
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
                <td className="border p-1">{money(v.totalCreditMoney)}</td>
                <td className="border p-1">{v.ordersCreated}</td>
              </tr>
            ))}
            {vendorSummary.length === 0 && !loading && (
              <tr>
                <td colSpan={9} className="p-3 text-center text-gray-500">
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
                  <td className="border p-1">{money(round2(p.totalMoney))}</td>
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
