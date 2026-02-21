import React, { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  serverTimestamp,
  getDoc,
  doc as fsDoc,
} from "firebase/firestore";
import { format } from "date-fns";
import { db, auth } from "../../firebase";
import RefreshButton from "../common/RefreshButton";
import useManualRefresh from "../../hooks/useManualRefresh";
import * as XLSX from "xlsx";
import {
  fetchGlobalInventoryKpisPollo_debug,
  fetchInventoryProductOptionsPollo,
  fetchProductEvolutionPollo,
  type InvMove,
  type ProductOption,
  type ProductKpis,
} from "../../Services/inventory_evolution_pollo";

const qty3 = (n: unknown) => Number(n ?? 0).toFixed(3);
const today = () => format(new Date(), "yyyy-MM-dd");

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

  // Search dropdown
  const [productSearch, setProductSearch] = useState("");
  const [productPickerOpen, setProductPickerOpen] = useState(false);

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
  const [adjQty, setAdjQty] = useState<number>(0);
  const [adjDesc, setAdjDesc] = useState("");
  const [adjModalOpen, setAdjModalOpen] = useState(false);

  const { refreshKey, refresh } = useManualRefresh();
  const [typeFilter, setTypeFilter] = useState<string>("ALL");
  const [priceFilter, setPriceFilter] = useState<string>("ALL");

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
          setProductSearch("");
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

  const filteredProducts = useMemo(() => {
    const q = norm(productSearch);
    if (!q) return products;

    return products.filter((p: any) => {
      const name = norm(p.productName || "");
      const key = norm(p.key || "");
      return name.includes(q) || key.includes(q);
    });
  }, [products, productSearch]);

  // sincroniza el input cuando cambias selectedKey
  useEffect(() => {
    if (!selectedKey) return;
    const p = products.find((x: any) => x.key === selectedKey);
    if (p) setProductSearch(p.productName || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  // =========================
  // Guardar ajuste manual
  // =========================
  const saveAdjustment = async () => {
    if (!selected) return window.alert("Seleccioná un producto primero.");

    const q = Number(adjQty || 0);
    if (q <= 0) return window.alert("Ingresá una cantidad > 0.");
    if (!adjDate) return window.alert("Seleccioná fecha.");

    const user = auth.currentUser;

    await addDoc(collection(db, "inventory_adjustments_pollo"), {
      date: adjDate,
      type: adjType, // MERMA / ROBO
      qty: q,
      productKey: selected.key,
      productId: (selected as any).productId ?? null,
      productName: selected.productName,
      measurement: selected.measurement, // lb o unidad
      description: adjDesc?.trim() || null,
      createdAt: serverTimestamp(),
      createdBy: user ? { uid: user.uid, email: user.email ?? null } : null,
      periodFrom: from,
      periodTo: to,
    });

    setAdjQty(0);
    setAdjDesc("");
    refresh();
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
            <div className="border rounded p-2 text-center">
              <div className="text-xs text-gray-500">Ingresado (Lbs)</div>
              <div className="font-bold">{qty3(global.incomingLbs)}</div>
            </div>
            <div className="border rounded p-2 text-center">
              <div className="text-xs text-gray-500">Ingresado (Unid)</div>
              <div className="font-bold">{qty3(global.incomingUnits)}</div>
            </div>
            <div className="border rounded p-2 text-center">
              <div className="text-xs text-gray-500">Existente (Lbs)</div>
              <div className="font-bold">{qty3(global.remainingLbs)}</div>
            </div>
            <div className="border rounded p-2 text-center">
              <div className="text-xs text-gray-500">Existente (Unid)</div>
              <div className="font-bold">{qty3(global.remainingUnits)}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Desktop KPIs */}
      <div className="hidden sm:grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Card
          title="Ingresado (Lbs) en rango"
          value={qty3(global.incomingLbs)}
        />
        <Card
          title="Ingresado (Unidades) en rango"
          value={qty3(global.incomingUnits)}
        />
        <Card
          title="Existente (Lbs) general"
          value={qty3(global.remainingLbs)}
        />
        <Card
          title="Existente (Unidades) general"
          value={qty3(global.remainingUnits)}
        />
      </div>

      {/* selector obligatorio */}
      {/* Mobile: producto + filtros + tabla inside a card */}
      <div className="sm:hidden mb-4">
        <div className="border rounded-2xl p-2 bg-white space-y-2">
          <div className="relative">
            <div className="text-xs text-gray-500 mb-1">
              Producto (solo con stock)
            </div>
            <div className="flex items-center gap-2">
              <input
                className="border rounded px-2 py-1.5 text-sm flex-1 min-w-0"
                placeholder="Buscar producto por nombre…"
                value={productSearch}
                onChange={(e) => {
                  setProductSearch(e.target.value);
                  setProductPickerOpen(true);
                }}
                onFocus={() => setProductPickerOpen(true)}
              />
              {selectedKey ? (
                <button
                  type="button"
                  aria-label="Limpiar producto"
                  title="Limpiar producto"
                  onClick={() => {
                    setSelectedKey("");
                    setProductSearch("");
                    setProductPickerOpen(false);
                  }}
                  className="bg-gray-200 text-gray-700 px-2 py-1 rounded-md hover:bg-gray-300 flex items-center justify-center text-sm"
                >
                  <span>🧹</span>
                </button>
              ) : null}
            </div>

            {/* Dropdown (same behavior as desktop) */}
            {productPickerOpen && (
              <div className="absolute z-50 mt-2 w-full bg-white border rounded-xl shadow-lg max-h-56 overflow-auto">
                <div className="px-2 py-1 text-xs text-gray-500 border-b bg-gray-50">
                  {filteredProducts.length} producto(s) con stock
                </div>

                {filteredProducts.length === 0 ? (
                  <div className="px-2 py-2 text-sm text-gray-500">
                    No hay coincidencias.
                  </div>
                ) : (
                  filteredProducts.map((p: any) => (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => {
                        if (selectedKey === p.key) {
                          setSelectedKey("");
                          setProductSearch("");
                        } else {
                          setSelectedKey(p.key);
                          setProductSearch(p.productName || "");
                        }
                        setProductPickerOpen(false);
                      }}
                      className="w-full text-left px-2 py-1.5 hover:bg-gray-100 active:bg-gray-200 text-sm"
                    >
                      <div className="font-medium truncate">
                        {p.productName}
                      </div>
                      <div className="text-[11px] text-gray-500">
                        {p.measurement === "lb" ? "Lbs" : "Unidades"} • stock:{" "}
                        {qty3((p as any).remaining)}
                      </div>
                    </button>
                  ))
                )}

                <div className="p-1 border-t bg-white">
                  <button
                    type="button"
                    className="w-full text-sm px-2 py-1 rounded-md border hover:bg-gray-50"
                    onClick={() => setProductPickerOpen(false)}
                  >
                    Cerrar
                  </button>
                </div>
              </div>
            )}

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
                  <div className="border rounded p-1.5 text-center bg-white text-sm">
                    <div className="text-[11px] text-gray-500">
                      {unitLabel} ingresadas (rango)
                    </div>
                    <div className="font-bold">
                      {qty3(productKpis.incoming)}
                    </div>
                  </div>
                  <div className="border rounded p-1.5 text-center bg-white text-sm">
                    <div className="text-[11px] text-gray-500">
                      {unitLabel} vendidas Cash
                    </div>
                    <div className="font-bold">
                      {qty3(productKpis.soldCash)}
                    </div>
                  </div>
                  <div className="border rounded p-1.5 text-center bg-white text-sm">
                    <div className="text-[11px] text-gray-500">
                      {unitLabel} vendidas Crédito
                    </div>
                    <div className="font-bold">
                      {qty3(productKpis.soldCredit)}
                    </div>
                  </div>
                  <div className="border rounded p-1.5 text-center bg-white text-sm">
                    <div className="text-[11px] text-gray-500">
                      {unitLabel} existentes
                    </div>
                    <div className="font-bold">
                      {qty3(productKpis.remaining)}
                    </div>
                  </div>
                </div>
              </>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAdjModalOpen(true)}
              className="bg-blue-600 text-white px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg text-sm sm:text-base hover:bg-blue-700"
            >
              Crear Movimiento
            </button>
            <button
              type="button"
              onClick={handleExportExcel}
              className="bg-green-600 text-white px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg text-sm sm:text-base hover:bg-green-700"
            >
              Exportar Excel
            </button>
          </div>

          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
            <div className="w-full sm:w-auto flex items-center gap-2">
              <label className="text-sm text-gray-700">Tipo:</label>
              <select
                className="border rounded px-2 py-2 w-full sm:w-auto"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
              >
                <option value="ALL">Todos</option>
                <option value="INGRESO">INGRESO</option>
                <option value="VENTA_CASH">VENTA_CASH</option>
                <option value="VENTA_CREDITO">VENTA_CREDITO</option>
                <option value="MERMA">MERMA</option>
                <option value="ROBO">ROBO</option>
              </select>
            </div>

            <div className="w-full sm:w-auto flex items-center gap-2">
              <label className="text-sm text-gray-700">Precio:</label>
              <select
                className="border rounded px-2 py-2 w-full sm:w-auto"
                value={priceFilter}
                onChange={(e) => setPriceFilter(e.target.value)}
              >
                <option value="ALL">Todos</option>
                {availablePrices &&
                  availablePrices.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
              </select>
            </div>
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
                return (
                  <div
                    key={`${m.ref || idx}-${m.date}`}
                    className="border rounded p-2 bg-white text-sm"
                  >
                    <div className="flex justify-between items-start">
                      <div className="text-[11px] text-gray-500">{m.date}</div>
                      <div className="text-sm font-semibold">{m.type}</div>
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
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Desktop selector + table */}
      <div className="hidden sm:grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
        <div className="relative">
          <label className="block text-sm text-gray-600 mb-1">
            Producto (solo con stock)
          </label>

          <div className="flex items-center gap-4">
            <input
              className="border rounded px-3 py-2 flex-1 min-w-0"
              placeholder="Buscar producto por nombre…"
              value={productSearch}
              onChange={(e) => {
                setProductSearch(e.target.value);
                setProductPickerOpen(true);
              }}
              onFocus={() => setProductPickerOpen(true)}
            />

            {/* Clear button when a product is selected (broom icon) */}
            {selectedKey ? (
              <button
                type="button"
                aria-label="Limpiar producto"
                title="Limpiar producto"
                onClick={() => {
                  setSelectedKey("");
                  setProductSearch("");
                  setProductPickerOpen(false);
                }}
                className="bg-blue-600 text-white px-2 py-1 sm:px-3 sm:py-2 rounded-md text-sm hover:bg-blue-700 flex items-center justify-center"
              >
                <span className="text-sm">Limpiar</span>
              </button>
            ) : null}
          </div>

          {/* Dropdown */}
          {productPickerOpen && (
            <div className="absolute z-50 mt-2 w-full bg-white border rounded-xl shadow-lg max-h-72 overflow-auto">
              <div className="px-3 py-2 text-xs text-gray-500 border-b bg-gray-50">
                {filteredProducts.length} producto(s) con stock
              </div>

              {filteredProducts.length === 0 ? (
                <div className="px-3 py-3 text-sm text-gray-500">
                  No hay coincidencias.
                </div>
              ) : (
                filteredProducts.map((p: any) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => {
                      if (selectedKey === p.key) {
                        // toggle off if clicking the already selected product
                        setSelectedKey("");
                        setProductSearch("");
                      } else {
                        setSelectedKey(p.key);
                        setProductSearch(p.productName || "");
                      }
                      setProductPickerOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-gray-100 active:bg-gray-200"
                  >
                    <div className="font-medium truncate">{p.productName}</div>
                    <div className="text-xs text-gray-500">
                      {p.measurement === "lb" ? "Lbs" : "Unidades"} • stock:{" "}
                      {qty3((p as any).remaining)}
                    </div>
                  </button>
                ))
              )}

              <div className="p-2 border-t bg-white">
                <button
                  type="button"
                  className="w-full text-sm px-3 py-2 rounded-lg border hover:bg-gray-50"
                  onClick={() => setProductPickerOpen(false)}
                >
                  Cerrar
                </button>
              </div>
            </div>
          )}

          {/* Click fuera para cerrar */}
          {productPickerOpen && (
            <button
              type="button"
              className="fixed inset-0 z-40 cursor-default"
              onClick={() => setProductPickerOpen(false)}
              aria-label="close"
            />
          )}

          {!selectedKey ? (
            <div className="mt-1 text-xs text-red-600">
              Debés seleccionar un producto para ver el evolutivo.
            </div>
          ) : null}
        </div>

        <div className="text-sm text-gray-700 flex items-end">
          {selected ? (
            <button
              type="button"
              onClick={() => {
                // allow clearing selection by clicking the selected panel
                setSelectedKey("");
                setProductSearch("");
              }}
              className="w-full border rounded-xl bg-white p-3 text-left"
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
            </button>
          ) : (
            <div className="w-full text-gray-500">
              Para ver el evolutivo tenés que seleccionar un producto.
            </div>
          )}
        </div>
      </div>

      {/* KPIs por producto */}
      {selected && (
        <div className="hidden sm:grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          <Card
            title={`${unitLabel} ingresadas (rango)`}
            value={qty3(productKpis.incoming)}
          />
          <Card
            title={`${unitLabel} vendidas Cash (rango)`}
            value={qty3(productKpis.soldCash)}
          />
          <Card
            title={`${unitLabel} vendidas Crédito (rango)`}
            value={qty3(productKpis.soldCredit)}
          />
          <Card
            title={`${unitLabel} existentes (stock actual)`}
            value={qty3(productKpis.remaining)}
          />
        </div>
      )}

      {/* movimientos manuales (botón + modal) */}
      {selected && (
        <>
          <div className="mb-4 hidden sm:flex gap-2 items-center">
            <button
              type="button"
              onClick={() => setAdjModalOpen(true)}
              className="bg-blue-600 text-white px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg text-sm sm:text-base hover:bg-blue-700"
            >
              Crear Movimiento
            </button>

            <button
              type="button"
              onClick={handleExportExcel}
              className="bg-green-600 text-white px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg text-sm sm:text-base hover:bg-green-700"
            >
              Exportar Excel
            </button>

            <div className="flex items-center space-x-2 ml-2">
              <label className="text-sm text-gray-700">Tipo:</label>
              <select
                className="border rounded px-2 py-2"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
              >
                <option value="ALL">Todos</option>
                <option value="INGRESO">INGRESO</option>
                <option value="VENTA_CASH">VENTA_CASH</option>
                <option value="VENTA_CREDITO">VENTA_CREDITO</option>
                <option value="MERMA">MERMA</option>
                <option value="ROBO">ROBO</option>
              </select>

              <label className="text-sm text-gray-700">Precio:</label>
              <select
                className="border rounded px-2 py-2"
                value={priceFilter}
                onChange={(e) => setPriceFilter(e.target.value)}
              >
                <option value="ALL">Todos</option>
                {availablePrices &&
                  availablePrices.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
              </select>
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
                    <label className="block text-sm text-gray-600 mb-1">
                      Tipo
                    </label>
                    <select
                      className="border rounded px-3 py-2 w-full text-sm"
                      value={adjType}
                      onChange={(e) => setAdjType(e.target.value as AdjType)}
                    >
                      <option value="MERMA">Merma por peso</option>
                      <option value="ROBO">Pérdida/Robo</option>
                    </select>
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
                    <button
                      type="button"
                      onClick={async () => {
                        await saveAdjustment();
                        setAdjModalOpen(false);
                      }}
                      className="w-full bg-blue-600 text-white px-3 py-2 rounded-lg text-sm hover:bg-blue-700"
                    >
                      Guardar
                    </button>
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

                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setAdjModalOpen(false)}
                    className="px-3 py-1.5 sm:px-4 sm:py-2 rounded-md border text-sm hover:bg-gray-50"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* listado evolutivo */}
      {/* Desktop table (hidden on mobile) */}
      <div className="hidden sm:overflow-x-auto">
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
            </tr>
          </thead>
          <tbody>
            {!selected ? (
              <tr>
                <td colSpan={8} className="p-4 text-center text-gray-500">
                  Seleccioná un producto para ver su evolutivo.
                </td>
              </tr>
            ) : loading ? (
              <tr>
                <td colSpan={8} className="p-4 text-center text-gray-500">
                  Cargando movimientos…
                </td>
              </tr>
            ) : movesWithBalance.length === 0 ? (
              <tr>
                <td colSpan={8} className="p-4 text-center text-gray-500">
                  No hay movimientos en el rango para este producto.
                </td>
              </tr>
            ) : (
              movesWithBalance.map((m, idx) => (
                <tr key={`${m.ref || idx}-${m.date}`} className="text-center">
                  <td className="border p-1">{m.date}</td>
                  <td className="border p-1">
                    <span
                      className={
                        m.type === "INGRESO"
                          ? "text-green-600 font-semibold"
                          : m.type === "VENTA_CASH" ||
                              m.type === "VENTA_CREDITO"
                            ? "text-red-600 font-semibold"
                            : "text-gray-700"
                      }
                    >
                      {m.type}
                    </span>
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
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile: already rendered above inside card (sm:hidden) */}
    </div>
  );
}

function Card({ title, value }: { title: string; value: string }) {
  return (
    <div className="border rounded-2xl p-3 bg-white">
      <div className="text-xs text-gray-500">{title}</div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}
