// src/components/Candies/PrecioVentas.tsx
import React, { useEffect, useMemo, useState } from "react";
import { collection, getDocs, query } from "firebase/firestore";
import { db } from "../../firebase";
import RefreshButton from "../common/RefreshButton";
import useManualRefresh from "../../hooks/useManualRefresh";

type PriceRow = {
  productId: string;
  category: string;
  productName: string;
  priceIsla: number;
  priceRivas: number;
  _sortKey: number;
};

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

function norm(s: any) {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function toNum(v: any, fallback = 0) {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : fallback;
}

function parseDateKey(dateStr: any) {
  const s = String(dateStr || "").trim();
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

export default function PrecioVentas() {
  const { refreshKey, refresh } = useManualRefresh();

  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  const [rows, setRows] = useState<PriceRow[]>([]);

  // filtros
  const [searchProduct, setSearchProduct] = useState("");
  const [minPrice, setMinPrice] = useState<string>("");
  const [maxPrice, setMaxPrice] = useState<string>("");
  const [priceField, setPriceField] = useState<"ANY" | "ISLA" | "RIVAS">("ANY");

  // UI móvil
  const [filtersOpenMobile, setFiltersOpenMobile] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg("");
      try {
        const snap = await getDocs(query(collection(db, "candy_main_orders")));

        const map = new Map<string, PriceRow>();

        snap.forEach((d) => {
          const x = d.data() as any;

          const dateKey = parseDateKey(x.date);
          const createdAtMs =
            x?.createdAt?.toMillis?.() ||
            (x?.createdAt?.seconds ? x.createdAt.seconds * 1000 : 0) ||
            0;

          const sortKey = Math.max(dateKey, createdAtMs);

          const items: any[] = Array.isArray(x.items) ? x.items : [];
          for (const it of items) {
            const productId = String(it?.id || it?.productId || "").trim();
            if (!productId) continue;

            const productName = String(
              it?.name || it?.productName || ""
            ).trim();
            const category = String(it?.category || "").trim();

            const priceIsla = Number(it?.unitPriceIsla || 0);
            const priceRivas = Number(it?.unitPriceRivas || 0);

            const current = map.get(productId);
            if (!current || sortKey >= current._sortKey) {
              map.set(productId, {
                productId,
                category,
                productName,
                priceIsla,
                priceRivas,
                _sortKey: sortKey,
              });
            }
          }
        });

        const list = Array.from(map.values()).sort((a, b) =>
          a.productName.localeCompare(b.productName, "es")
        );

        setRows(list);
      } catch (e) {
        console.error(e);
        setMsg("❌ Error cargando precios desde órdenes maestras.");
        setRows([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshKey]);

  const filtered = useMemo(() => {
    const q = norm(searchProduct);

    const min = minPrice.trim() === "" ? null : toNum(minPrice, NaN);
    const max = maxPrice.trim() === "" ? null : toNum(maxPrice, NaN);

    return rows.filter((r) => {
      if (q) {
        const hay = `${r.category} ${r.productName}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }

      const prices =
        priceField === "ISLA"
          ? [r.priceIsla]
          : priceField === "RIVAS"
          ? [r.priceRivas]
          : [r.priceIsla, r.priceRivas];

      const minOk =
        min == null || !Number.isFinite(min)
          ? true
          : prices.some((p) => p >= (min as number));

      const maxOk =
        max == null || !Number.isFinite(max)
          ? true
          : prices.some((p) => p <= (max as number));

      return minOk && maxOk;
    });
  }, [rows, searchProduct, minPrice, maxPrice, priceField]);

  const clearFilters = () => {
    setSearchProduct("");
    setMinPrice("");
    setMaxPrice("");
    setPriceField("ANY");
  };

  const hasActiveFilters = useMemo(() => {
    return (
      searchProduct.trim() !== "" ||
      minPrice.trim() !== "" ||
      maxPrice.trim() !== "" ||
      priceField !== "ANY"
    );
  }, [searchProduct, minPrice, maxPrice, priceField]);

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Precio Ventas</h2>
        <div className="flex gap-2">
          <RefreshButton onClick={refresh} loading={loading} />
        </div>
      </div>

      {/* ===== MOBILE: filtros colapsables ===== */}
      <div className="md:hidden mb-3">
        <button
          type="button"
          onClick={() => setFiltersOpenMobile((v) => !v)}
          className={`w-full px-3 py-3 rounded-xl border shadow-sm flex items-center justify-between ${
            hasActiveFilters ? "bg-yellow-50 border-yellow-200" : "bg-white"
          }`}
        >
          <div className="text-left">
            <div className="font-semibold">Filtros</div>
            <div className="text-xs text-gray-600">
              {hasActiveFilters ? "Activos" : "Ninguno"}
              {" • "}
              Mostrando <b>{filtered.length}</b>
            </div>
          </div>
          <div className="text-sm font-semibold">
            {filtersOpenMobile ? "Cerrar" : "Abrir"}
          </div>
        </button>

        {filtersOpenMobile && (
          <div className="mt-2 bg-white border rounded-xl shadow-sm p-3 text-sm">
            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="block font-semibold">Producto</label>
                <input
                  className="w-full border rounded px-2 py-2"
                  value={searchProduct}
                  onChange={(e) => setSearchProduct(e.target.value)}
                  placeholder="Ej: Conitos, Gomitas…"
                />
              </div>

              <div>
                <label className="block font-semibold">Precio en</label>
                <select
                  className="w-full border rounded px-2 py-2"
                  value={priceField}
                  onChange={(e) => setPriceField(e.target.value as any)}
                >
                  <option value="ANY">Isla o Rivas</option>
                  <option value="ISLA">Solo Isla</option>
                  <option value="RIVAS">Solo Rivas</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-semibold">Mín</label>
                  <input
                    className="w-full border rounded px-2 py-2 text-right"
                    inputMode="decimal"
                    value={minPrice}
                    onChange={(e) => setMinPrice(e.target.value)}
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block font-semibold">Máx</label>
                  <input
                    className="w-full border rounded px-2 py-2 text-right"
                    inputMode="decimal"
                    value={maxPrice}
                    onChange={(e) => setMaxPrice(e.target.value)}
                    placeholder="0"
                  />
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  className="flex-1 px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
                  onClick={clearFilters}
                >
                  Limpiar
                </button>
                <button
                  type="button"
                  className="flex-1 px-3 py-2 rounded bg-indigo-600 text-white hover:bg-indigo-700"
                  onClick={() => setFiltersOpenMobile(false)}
                >
                  Aplicar
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ===== WEB: filtros siempre visibles (igual idea de antes) ===== */}
      <div className="hidden md:block bg-white p-3 rounded shadow border mb-3 text-sm">
        <div className="grid grid-cols-6 gap-3 items-end">
          <div className="col-span-2">
            <label className="block font-semibold">Filtrar por producto</label>
            <input
              className="w-full border rounded px-2 py-1"
              value={searchProduct}
              onChange={(e) => setSearchProduct(e.target.value)}
              placeholder="Ej: Conitos, Gomitas…"
            />
          </div>

          <div>
            <label className="block font-semibold">Precio en</label>
            <select
              className="w-full border rounded px-2 py-1"
              value={priceField}
              onChange={(e) => setPriceField(e.target.value as any)}
            >
              <option value="ANY">Isla o Rivas</option>
              <option value="ISLA">Solo Isla</option>
              <option value="RIVAS">Solo Rivas</option>
            </select>
          </div>

          <div>
            <label className="block font-semibold">Precio mín</label>
            <input
              className="w-full border rounded px-2 py-1 text-right"
              inputMode="decimal"
              value={minPrice}
              onChange={(e) => setMinPrice(e.target.value)}
              placeholder="0"
            />
          </div>

          <div>
            <label className="block font-semibold">Precio máx</label>
            <input
              className="w-full border rounded px-2 py-1 text-right"
              inputMode="decimal"
              value={maxPrice}
              onChange={(e) => setMaxPrice(e.target.value)}
              placeholder="0"
            />
          </div>

          <div className="text-right">
            <button
              className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
              type="button"
              onClick={clearFilters}
            >
              Limpiar
            </button>
          </div>
        </div>

        <div className="mt-2 flex items-center justify-between">
          <div className="text-xs text-gray-600">
            Fuente: <b>candy_main_orders.items[]</b> • Muestra el{" "}
            <b>último precio</b> registrado por producto.
          </div>
          <div className="text-sm">
            <span className="text-gray-600">Mostrando:</span>{" "}
            <b>{filtered.length}</b>
          </div>
        </div>
      </div>

      {/* ===== MOBILE: lista/cards ===== */}
      <div className="md:hidden">
        {loading ? (
          <div className="bg-white rounded-xl border shadow p-4 text-center">
            Cargando…
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-xl border shadow p-4 text-center">
            Sin resultados.
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((r) => (
              <div
                key={r.productId}
                className="bg-white rounded-xl border shadow-sm p-3"
              >
                <div className="text-xs text-gray-600">{r.category}</div>
                <div className="text-base font-bold leading-tight">
                  {r.productName}
                </div>

                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div className="rounded-lg border bg-gray-50 p-2">
                    <div className="text-[11px] text-gray-600">Isla</div>
                    <div className="text-lg font-extrabold tabular-nums">
                      {money(r.priceIsla)}
                    </div>
                  </div>

                  <div className="rounded-lg border bg-gray-50 p-2">
                    <div className="text-[11px] text-gray-600">Rivas</div>
                    <div className="text-lg font-extrabold tabular-nums">
                      {money(r.priceRivas)}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {msg && <p className="mt-2 text-sm">{msg}</p>}
      </div>

      {/* ===== WEB: tabla ===== */}
      <div className="hidden md:block bg-white rounded shadow border w-full overflow-x-auto">
        <table className="min-w-[900px] w-full text-sm">
          <thead className="bg-gray-100">
            <tr className="whitespace-nowrap">
              <th className="p-2 border text-left">Categoría</th>
              <th className="p-2 border text-left">Producto</th>
              <th className="p-2 border text-right">Precio Isla</th>
              <th className="p-2 border text-right">Precio Rivas</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="p-4 text-center" colSpan={4}>
                  Cargando…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td className="p-4 text-center" colSpan={4}>
                  Sin resultados.
                </td>
              </tr>
            ) : (
              filtered.map((r) => (
                <tr key={r.productId}>
                  <td className="p-2 border">{r.category}</td>
                  <td className="p-2 border">{r.productName}</td>
                  <td className="p-2 border text-right tabular-nums">
                    {money(r.priceIsla)}
                  </td>
                  <td className="p-2 border text-right tabular-nums">
                    {money(r.priceRivas)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* msg para web (móvil ya lo muestra arriba) */}
      {msg && <p className="hidden md:block mt-2 text-sm">{msg}</p>}
    </div>
  );
}
