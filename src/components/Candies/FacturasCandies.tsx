// src/components/Candies/InvoiceCandiesModal.tsx
import React, { useEffect, useMemo, useState } from "react";
import { db } from "../../firebase";
import {
  addDoc,
  collection,
  getDocs,
  orderBy,
  query,
  Timestamp,
} from "firebase/firestore";
import { format } from "date-fns";

type CandyTransaction = {
  id: string;
  date: string; // yyyy-MM-dd (fecha de venta)
  productId?: string | null;
  productName: string;
  vendorName: string; // etiqueta que se mostrará en la tabla
  sellerEmail?: string | null; // para cruzar con sellers_candies
  packages: number; // cantidad de paquetes vendidos
  amount: number; // total venta (ingreso)
  cogsAmount: number; // costo total proveedor (COGS)
};

type Expense = {
  id: string;
  date?: string;
  description?: string;
  amount?: number;
};

type Adjustment = {
  id: string;
  description: string;
  type: "DEBITO" | "CREDITO";
  amount: number;
};

type SellerCandy = {
  id: string;
  name: string;
  email?: string;
  commissionPercent?: number; // % de comisión del vendedor sobre la venta
};

const money = (n: number | string) => `C$${Number(n || 0).toFixed(2)}`;
const qty3 = (n: number | string) => Number(n || 0).toFixed(3);

const firstDayOfMonth = () => {
  const d = new Date();
  return format(new Date(d.getFullYear(), d.getMonth(), 1), "yyyy-MM-dd");
};
const todayStr = () => format(new Date(), "yyyy-MM-dd");

export default function InvoiceCandiesModal({
  transactions = [],
  onClose,
  onCreated,
}: {
  transactions?: CandyTransaction[];
  onClose: () => void;
  onCreated: () => void;
}) {
  // ========= Data base =========
  const safeTx: CandyTransaction[] = Array.isArray(transactions)
    ? transactions
    : [];

  // ========= Catálogo de vendedores (para comisión y filtro) =========
  const [sellers, setSellers] = useState<SellerCandy[]>([]);
  const sellersByEmail = useMemo(() => {
    const m: Record<string, SellerCandy> = {};
    sellers.forEach((s) => {
      if (s.email) {
        m[s.email.trim().toLowerCase()] = s;
      }
    });
    return m;
  }, [sellers]);

  useEffect(() => {
    (async () => {
      try {
        const qy = query(
          collection(db, "sellers_candies"),
          orderBy("name", "asc")
        );
        const snap = await getDocs(qy);
        const rows: SellerCandy[] = [];
        snap.forEach((d) => {
          const it = d.data() as any;
          rows.push({
            id: d.id,
            name: it.name || "",
            email: it.email || "",
            commissionPercent: Number(it.commissionPercent || 0),
          });
        });
        setSellers(rows);
      } catch (e) {
        console.error(e);
      }
    })();
  }, []);

  // ========= Filtros de Transacciones =========
  const [txFrom, setTxFrom] = useState<string>(firstDayOfMonth());
  const [txTo, setTxTo] = useState<string>(todayStr());
  const [productFilter, setProductFilter] = useState<string>("");
  const [sellerFilter, setSellerFilter] = useState<string>(""); // email del vendedor

  const productOptions = useMemo(() => {
    const m = new Map<string, { key: string; name: string }>();
    safeTx.forEach((t) => {
      const key = t.productId || t.productName;
      m.set(key, { key, name: t.productName });
    });
    return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [safeTx]);

  const sellerOptions = useMemo(() => {
    const m = new Map<string, { email: string; label: string }>();
    safeTx.forEach((t) => {
      const email = (t.sellerEmail || "").trim().toLowerCase();
      if (!email) return;
      const seller = sellersByEmail[email];
      const label = seller?.name || t.vendorName || email;
      m.set(email, { email, label });
    });
    return Array.from(m.values()).sort((a, b) =>
      a.label.localeCompare(b.label)
    );
  }, [safeTx, sellersByEmail]);

  const filteredTx = useMemo(() => {
    return safeTx.filter((t) => {
      if (txFrom && t.date < txFrom) return false;
      if (txTo && t.date > txTo) return false;

      if (productFilter) {
        const key = t.productId || t.productName;
        if (key !== productFilter) return false;
      }

      if (sellerFilter) {
        const email = (t.sellerEmail || "").trim().toLowerCase();
        if (email !== sellerFilter) return false;
      }

      return true;
    });
  }, [safeTx, txFrom, txTo, productFilter, sellerFilter]);

  // ========= Datos de factura =========
  const [invoiceDate, setInvoiceDate] = useState<string>(todayStr());
  const [invoiceNumber, setInvoiceNumber] = useState<string>(
    () => `FAC-CANDY-${Date.now().toString().slice(-6)}`
  );
  const [description, setDescription] = useState<string>("");

  // Factor sucursal (para calcular ganancia de sucursal sobre ventas)
  const [branchFactorPercent, setBranchFactorPercent] = useState<string>("0");

  // Selección de transacciones
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    filteredTx.map((t) => t.id)
  );
  useEffect(() => {
    // mantener coherencia al cambiar filtros
    setSelectedIds((prev) =>
      prev.filter((id) => filteredTx.some((t) => t.id === id))
    );
  }, [filteredTx]);

  // ========= Gastos (colección específica de dulces) =========
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [selectedExpenseIds, setSelectedExpenseIds] = useState<string[]>([]);
  const [loadingExpenses, setLoadingExpenses] = useState<boolean>(false);
  const [expFrom, setExpFrom] = useState<string>(firstDayOfMonth());
  const [expTo, setExpTo] = useState<string>(todayStr());

  useEffect(() => {
    (async () => {
      try {
        setLoadingExpenses(true);
        // NOTA: colección de gastos para dulces
        const qy = query(
          collection(db, "expensesCandies"),
          orderBy("date", "desc")
        );
        const snap = await getDocs(qy);
        const rows: Expense[] = [];
        snap.forEach((d) => {
          const it = d.data() as any;
          rows.push({
            id: d.id,
            date: it.date,
            description: it.description,
            amount: Number(it.amount || 0),
          });
        });
        setExpenses(rows);
      } catch (e) {
        console.error(e);
      } finally {
        setLoadingExpenses(false);
      }
    })();
  }, []);

  const filteredExpenses = useMemo(() => {
    return expenses.filter((g) => {
      if (!g.date) return false;
      if (expFrom && g.date < expFrom) return false;
      if (expTo && g.date > expTo) return false;
      return true;
    });
  }, [expenses, expFrom, expTo]);

  // ========= Notas Crédito/Débito =========
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [openAdjModal, setOpenAdjModal] = useState<boolean>(false);
  const [adjDesc, setAdjDesc] = useState<string>("");
  const [adjType, setAdjType] = useState<"DEBITO" | "CREDITO">("DEBITO");
  const [adjAmount, setAdjAmount] = useState<string>("");

  const addAdjustment = () => {
    const amt = Number(adjAmount);
    if (!adjDesc.trim() || !isFinite(amt) || amt <= 0) return;
    setAdjustments((prev) => [
      ...prev,
      {
        id: `${Date.now()}_${prev.length + 1}`,
        description: adjDesc.trim(),
        type: adjType,
        amount: Number(amt.toFixed(2)),
      },
    ]);
    setAdjDesc("");
    setAdjAmount("");
  };

  const [editingAdjId, setEditingAdjId] = useState<string | null>(null);
  const [editAdjDesc, setEditAdjDesc] = useState<string>("");
  const [editAdjType, setEditAdjType] = useState<"DEBITO" | "CREDITO">(
    "DEBITO"
  );
  const [editAdjAmount, setEditAdjAmount] = useState<string>("");

  const beginEditAdjustment = (a: Adjustment) => {
    setEditingAdjId(a.id);
    setEditAdjDesc(a.description);
    setEditAdjType(a.type);
    setEditAdjAmount(a.amount.toFixed(2));
  };
  const cancelEditAdjustment = () => {
    setEditingAdjId(null);
    setEditAdjDesc("");
    setEditAdjType("DEBITO");
    setEditAdjAmount("");
  };
  const saveEditAdjustment = () => {
    if (!editingAdjId) return;
    const amt = Number(editAdjAmount);
    if (!isFinite(amt) || amt <= 0) return;
    setAdjustments((prev) =>
      prev.map((x) =>
        x.id === editingAdjId
          ? {
              ...x,
              description: editAdjDesc.trim(),
              type: editAdjType,
              amount: Number(amt.toFixed(2)),
            }
          : x
      )
    );
    cancelEditAdjustment();
  };
  const removeAdjustment = (id: string) => {
    setAdjustments((prev) => prev.filter((x) => x.id !== id));
    if (editingAdjId === id) cancelEditAdjustment();
  };

  // ========= Selección =========
  const toggleTx = (id: string, checked: boolean) => {
    setSelectedIds((prev) =>
      checked ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)
    );
  };
  const selectAllTx = (checked: boolean) => {
    setSelectedIds(checked ? filteredTx.map((t) => t.id) : []);
  };
  const toggleExpense = (id: string, checked: boolean) => {
    setSelectedExpenseIds((prev) =>
      checked ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)
    );
  };

  // ========= Cálculos =========
  const selectedTx = useMemo(
    () => filteredTx.filter((t) => selectedIds.includes(t.id)),
    [filteredTx, selectedIds]
  );

  const debitsSum = useMemo(
    () =>
      adjustments
        .filter((a) => a.type === "DEBITO")
        .reduce((s, a) => s + a.amount, 0),
    [adjustments]
  );
  const creditsSum = useMemo(
    () =>
      adjustments
        .filter((a) => a.type === "CREDITO")
        .reduce((s, a) => s + a.amount, 0),
    [adjustments]
  );

  const totals = useMemo(() => {
    let totalPackages = 0;
    let totalProvider = 0;
    let totalSale = 0;
    let totalCommissionVendors = 0;

    for (const t of selectedTx) {
      const packs = Number(t.packages || 0);
      const providerTotal = Number(t.cogsAmount || 0);
      const saleTotal = Number(t.amount || 0);

      totalPackages += packs;
      totalProvider += providerTotal;
      totalSale += saleTotal;

      // comisión por vendedor (si existe)
      const email = (t.sellerEmail || "").trim().toLowerCase();
      const seller = sellersByEmail[email];
      const commissionPercent = Number(seller?.commissionPercent || 0);
      const lineCommission = (saleTotal * commissionPercent) / 100;
      totalCommissionVendors += lineCommission;
    }

    const totalGastos = filteredExpenses
      .filter((g) => selectedExpenseIds.includes(g.id))
      .reduce((a, g) => a + Number(g.amount || 0), 0);

    const grossProfit = totalSale - totalProvider; // margen sobre costo
    const finalAmount =
      totalSale - totalGastos - debitsSum + creditsSum - totalCommissionVendors;

    const branchFactor = Number(branchFactorPercent || 0);
    const branchProfit = (totalSale * branchFactor) / 100;

    return {
      totalPackages: Number(qty3(totalPackages)),
      totalProvider: Number(totalProvider.toFixed(2)),
      totalSale: Number(totalSale.toFixed(2)),
      totalGastos: Number(totalGastos.toFixed(2)),
      debits: Number(debitsSum.toFixed(2)),
      credits: Number(creditsSum.toFixed(2)),
      grossProfit: Number(grossProfit.toFixed(2)),
      finalAmount: Number(finalAmount.toFixed(2)),
      totalCommissionVendors: Number(totalCommissionVendors.toFixed(2)),
      branchProfit: Number(branchProfit.toFixed(2)),
      branchFactor,
    };
  }, [
    selectedTx,
    filteredExpenses,
    selectedExpenseIds,
    debitsSum,
    creditsSum,
    sellersByEmail,
    branchFactorPercent,
  ]);

  // ========= Guardar =========
  const [creating, setCreating] = useState<boolean>(false);
  const [msg, setMsg] = useState<string>("");

  const createInvoice = async () => {
    setMsg("");
    if (selectedTx.length === 0) {
      setMsg("Selecciona al menos 1 transacción procesada.");
      return;
    }
    try {
      setCreating(true);

      const invoicePayload = {
        number: invoiceNumber.trim(),
        date: invoiceDate,
        description: description.trim(),
        status: "PENDIENTE" as const,
        createdAt: Timestamp.now(),

        // Totales
        totalPackages: totals.totalPackages,
        totalProvider: totals.totalProvider, // costo proveedor
        totalSale: totals.totalSale, // ventas
        totalExpenses: totals.totalGastos,
        totalDebits: totals.debits,
        totalCredits: totals.credits,
        grossProfit: totals.grossProfit, // venta - costo
        totalCommissionVendors: totals.totalCommissionVendors,
        branchFactorPercent: totals.branchFactor,
        branchProfit: totals.branchProfit,
        finalAmount: totals.finalAmount,

        // Detalle transacciones
        transactions: selectedTx.map((t) => {
          const packs = Number(t.packages || 0) || 1;
          const providerTotal = Number(t.cogsAmount || 0);
          const saleTotal = Number(t.amount || 0);

          const providerPricePack = providerTotal / packs;
          const salePricePack = saleTotal / packs;

          const email = (t.sellerEmail || "").trim().toLowerCase();
          const seller = sellersByEmail[email];
          const commissionPercent = Number(seller?.commissionPercent || 0);
          const commissionAmount = (saleTotal * commissionPercent) / 100;

          return {
            id: t.id,
            date: t.date,
            productId: t.productId || null,
            productName: t.productName,
            vendorName: t.vendorName,
            sellerEmail: t.sellerEmail || null,
            packages: Number(qty3(t.packages)),
            providerPricePack: Number(providerPricePack.toFixed(4)),
            salePricePack: Number(salePricePack.toFixed(4)),
            totalProvider: Number(providerTotal.toFixed(2)),
            totalSale: Number(saleTotal.toFixed(2)),
            commissionPercent,
            commissionAmount: Number(commissionAmount.toFixed(2)),
          };
        }),

        // Gastos
        expenses: filteredExpenses
          .filter((g) => selectedExpenseIds.includes(g.id))
          .map((g) => ({
            id: g.id,
            date: g.date || null,
            description: g.description || "",
            amount: Number(Number(g.amount || 0).toFixed(2)),
          })),

        // Ajustes
        adjustments: adjustments.map((a) => ({
          id: a.id,
          description: a.description,
          type: a.type,
          amount: Number(a.amount.toFixed(2)),
        })),
      };

      // NOTA: colección separada para facturas de dulces
      await addDoc(collection(db, "invoicesCandies"), invoicePayload);

      setMsg("✅ Factura de dulces creada.");
      onCreated();
    } catch (e: any) {
      console.error(e);
      setMsg(`❌ Error al crear factura: ${e?.message || "desconocido"}`);
    } finally {
      setCreating(false);
    }
  };

  // ========= UI =========
  return (
    <div className="fixed inset-0 z-[9999] bg-black/40 flex items-center justify-center p-3">
      <div className="bg-white w-full max-w-6xl rounded-xl shadow-xl p-4 md:p-6 max-h-[90vh] overflow-auto relative">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <h3 className="text-lg font-semibold">Crear factura CandyShop</h3>
          <button
            onClick={onClose}
            className="ml-auto px-2 py-1 border rounded hover:bg-gray-50"
          >
            Cerrar
          </button>
        </div>

        {/* Datos de factura */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
          <div>
            <label className="block text-sm font-medium">Fecha</label>
            <input
              type="date"
              className="w-full border rounded px-2 py-1"
              value={invoiceDate}
              onChange={(e) => setInvoiceDate(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium">Número</label>
            <input
              type="text"
              className="w-full border rounded px-2 py-1"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              placeholder="FAC-CANDY-001"
            />
          </div>
          <div>
            <label className="block text-sm font-medium">
              Factor sucursal (%)
            </label>
            <input
              type="number"
              step="0.01"
              className="w-full border rounded px-2 py-1"
              value={branchFactorPercent}
              onChange={(e) => setBranchFactorPercent(e.target.value)}
              placeholder="Ej: 30"
            />
            <p className="text-[11px] text-gray-500 mt-1">
              Se aplica sobre el total de ventas para calcular la ganancia de
              sucursal.
            </p>
          </div>
          <div className="md:col-span-1">
            <label className="block text-sm font-medium">Descripción</label>
            <input
              type="text"
              className="w-full border rounded px-2 py-1"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Comentarios de la factura"
            />
          </div>
        </div>

        {/* Filtros de Transacciones */}
        <div className="bg-gray-50 border rounded p-3 mb-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-sm font-medium">
                Desde (transacción)
              </label>
              <input
                type="date"
                className="border rounded px-2 py-1"
                value={txFrom}
                onChange={(e) => setTxFrom(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-medium">
                Hasta (transacción)
              </label>
              <input
                type="date"
                className="border rounded px-2 py-1"
                value={txTo}
                onChange={(e) => setTxTo(e.target.value)}
              />
            </div>
            <div className="min-w-[180px]">
              <label className="block text-sm font-medium">Producto</label>
              <select
                className="border rounded px-2 py-1 w-full"
                value={productFilter}
                onChange={(e) => setProductFilter(e.target.value)}
              >
                <option value="">Todos</option>
                {productOptions.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-[180px]">
              <label className="block text-sm font-medium">Vendedor</label>
              <select
                className="border rounded px-2 py-1 w-full"
                value={sellerFilter}
                onChange={(e) => setSellerFilter(e.target.value)}
              >
                <option value="">Todos</option>
                {sellerOptions.map((s) => (
                  <option key={s.email} value={s.email}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              className="ml-auto px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
              onClick={() => {
                setTxFrom(firstDayOfMonth());
                setTxTo(todayStr());
                setProductFilter("");
                setSellerFilter("");
              }}
            >
              Quitar filtro
            </button>
          </div>
        </div>

        {/* Selector de transacciones procesadas */}
        <div className="mb-4">
          <div className="flex items-center gap-3 mb-2">
            <h4 className="font-semibold">Transacciones procesadas</h4>
            <label className="text-sm flex items-center gap-2">
              <input
                type="checkbox"
                checked={
                  filteredTx.length > 0 &&
                  selectedIds.length === filteredTx.length
                }
                onChange={(e) => selectAllTx(e.target.checked)}
              />
              Seleccionar todas (sobre el filtro)
            </label>
          </div>

          {filteredTx.length === 0 ? (
            <p className="text-sm text-gray-500">
              No hay transacciones procesadas en el filtro actual.
            </p>
          ) : (
            <div className="border rounded max-h-80 overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="p-2 border">Sel</th>
                    <th className="p-2 border">Fecha</th>
                    <th className="p-2 border">Vendedor</th>
                    <th className="p-2 border">Producto</th>
                    <th className="p-2 border">Paquetes</th>
                    <th className="p-2 border">Precio proveedor</th>
                    <th className="p-2 border">Precio venta</th>
                    <th className="p-2 border">Total proveedor</th>
                    <th className="p-2 border">Total venta</th>
                    <th className="p-2 border">Comisión venta</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTx.map((t) => {
                    const checked = selectedIds.includes(t.id);
                    const packs = Number(t.packages || 0) || 1;
                    const providerTotal = Number(t.cogsAmount || 0);
                    const saleTotal = Number(t.amount || 0);
                    const providerPricePack = providerTotal / packs;
                    const salePricePack = saleTotal / packs;

                    const email = (t.sellerEmail || "").trim().toLowerCase();
                    const seller = sellersByEmail[email];
                    const commissionPercent = Number(
                      seller?.commissionPercent || 0
                    );
                    const commissionAmount =
                      (saleTotal * commissionPercent) / 100;

                    return (
                      <tr key={t.id} className="text-center">
                        <td className="p-2 border">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => toggleTx(t.id, e.target.checked)}
                          />
                        </td>
                        <td className="p-2 border">{t.date}</td>
                        <td className="p-2 border">
                          {seller?.name || t.vendorName}
                        </td>
                        <td className="p-2 border">{t.productName}</td>
                        <td className="p-2 border">{qty3(t.packages)}</td>
                        <td className="p-2 border">
                          {money(providerPricePack)}
                        </td>
                        <td className="p-2 border">{money(salePricePack)}</td>
                        <td className="p-2 border">{money(providerTotal)}</td>
                        <td className="p-2 border">{money(saleTotal)}</td>
                        <td className="p-2 border">
                          {commissionPercent > 0
                            ? `${money(
                                commissionAmount
                              )} (${commissionPercent.toFixed(2)}%)`
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Filtro + Tabla de Gastos (igual que en pollo pero usando expensesCandies) */}
        <div className="mb-4">
          <div className="flex items-center gap-3 mb-2">
            <h4 className="font-semibold">Gastos a incluir (opcional)</h4>
            {loadingExpenses && (
              <span className="text-xs text-gray-500">Cargando…</span>
            )}
            <div className="ml-auto flex items-end gap-3">
              <div>
                <label className="block text-xs text-gray-600">
                  Desde (gasto)
                </label>
                <input
                  type="date"
                  className="border rounded px-2 py-1"
                  value={expFrom}
                  onChange={(e) => setExpFrom(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600">
                  Hasta (gasto)
                </label>
                <input
                  type="date"
                  className="border rounded px-2 py-1"
                  value={expTo}
                  onChange={(e) => setExpTo(e.target.value)}
                />
              </div>
            </div>
          </div>

          {filteredExpenses.length === 0 ? (
            <p className="text-sm text-gray-500">
              No hay gastos en el rango seleccionado.
            </p>
          ) : (
            <div className="border rounded max-h-48 overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="p-2 border">Sel</th>
                    <th className="p-2 border">Fecha</th>
                    <th className="p-2 border">Descripción</th>
                    <th className="p-2 border">Monto</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredExpenses.map((g) => {
                    const checked = selectedExpenseIds.includes(g.id);
                    return (
                      <tr key={g.id} className="text-center">
                        <td className="p-2 border">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              toggleExpense(g.id, e.target.checked)
                            }
                          />
                        </td>
                        <td className="p-2 border">{g.date || "—"}</td>
                        <td className="p-2 border">{g.description || "—"}</td>
                        <td className="p-2 border">
                          {money(Number(g.amount || 0))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Notas Crédito/Débito (cargos) – igual que pollo */}
        <div className="mb-4">
          <div className="flex items-center gap-3 mb-2">
            <h4 className="font-semibold">
              Notas Crédito/Débito (Cargos extras)
            </h4>
            <button
              className="ml-auto px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
              onClick={() => setOpenAdjModal(true)}
            >
              Crear Cargo
            </button>
          </div>

          {adjustments.length === 0 ? (
            <p className="text-sm text-gray-500">Sin cargos agregados.</p>
          ) : (
            <div className="border rounded max-h-40 overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="p-2 border">Descripción</th>
                    <th className="p-2 border">Tipo</th>
                    <th className="p-2 border">Monto</th>
                    <th className="p-2 border">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {adjustments.map((a) => {
                    const isEditing = editingAdjId === a.id;
                    return (
                      <tr key={a.id} className="text-center">
                        <td className="p-2 border">
                          {isEditing ? (
                            <textarea
                              className="w-full border rounded px-2 py-1 min-h-[70px]"
                              value={editAdjDesc}
                              onChange={(e) => setEditAdjDesc(e.target.value)}
                            />
                          ) : (
                            <span title={a.description}>
                              {a.description.length > 60
                                ? `${a.description.slice(0, 60)}…`
                                : a.description}
                            </span>
                          )}
                        </td>
                        <td className="p-2 border">
                          {isEditing ? (
                            <select
                              className="w-full border rounded px-2 py-1"
                              value={editAdjType}
                              onChange={(e) =>
                                setEditAdjType(
                                  e.target.value as "DEBITO" | "CREDITO"
                                )
                              }
                            >
                              <option value="DEBITO">Débito</option>
                              <option value="CREDITO">Crédito</option>
                            </select>
                          ) : (
                            <span
                              className={`px-2 py-0.5 rounded text-xs ${
                                a.type === "DEBITO"
                                  ? "bg-red-100 text-red-700"
                                  : "bg-green-100 text-green-700"
                              }`}
                            >
                              {a.type}
                            </span>
                          )}
                        </td>
                        <td className="p-2 border">
                          {isEditing ? (
                            <input
                              type="number"
                              step="0.01"
                              className="w-full border rounded px-2 py-1 text-right"
                              value={editAdjAmount}
                              onChange={(e) => setEditAdjAmount(e.target.value)}
                            />
                          ) : (
                            money(a.amount)
                          )}
                        </td>
                        <td className="p-2 border">
                          {isEditing ? (
                            <div className="flex gap-2 justify-center">
                              <button
                                className="px-2 py-1 rounded bg-green-600 text-white hover:bg-green-700 text-xs"
                                onClick={saveEditAdjustment}
                              >
                                Guardar
                              </button>
                              <button
                                className="px-2 py-1 rounded bg-gray-200 hover:bg-gray-300 text-xs"
                                onClick={cancelEditAdjustment}
                              >
                                Cancelar
                              </button>
                              <button
                                className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 text-xs"
                                onClick={() => removeAdjustment(a.id)}
                              >
                                Eliminar
                              </button>
                            </div>
                          ) : (
                            <div className="flex gap-2 justify-center">
                              <button
                                className="px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 text-xs"
                                onClick={() => beginEditAdjustment(a)}
                              >
                                Editar
                              </button>
                              <button
                                className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 text-xs"
                                onClick={() => removeAdjustment(a.id)}
                              >
                                Eliminar
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Totales */}
        <div className="grid grid-cols-1 md:grid-cols-3 text-sm mb-4 justify-between">
          {/* Columna 1 */}
          <div className="space-y-1">
            <div>
              Total paquetes: <strong>{qty3(totals.totalPackages)}</strong>
            </div>
          </div>

          {/* Columna 2 */}
          <div className="space-y-1 text-center">
            <div>
              Total proveedor (costo):{" "}
              <strong>{money(totals.totalProvider)}</strong>
            </div>
            <div>
              Total venta: <strong>{money(totals.totalSale)}</strong>
            </div>
            <div>
              Ganancia bruta (venta − costo):{" "}
              <strong>{money(totals.grossProfit)}</strong>
            </div>
          </div>

          {/* Columna 3 */}
          <div className="space-y-1 text-right">
            <div>
              Gastos: <strong>{money(totals.totalGastos)}</strong>
            </div>
            <div>
              Débitos: <strong>{money(totals.debits)}</strong>
            </div>
            <div>
              Créditos: <strong>{money(totals.credits)}</strong>
            </div>
            <div>
              Comisión total vendedores:{" "}
              <strong>{money(totals.totalCommissionVendors)}</strong>
            </div>
            <div>
              Ganancia sucursal (ventas × factor):{" "}
              <strong>{money(totals.branchProfit)}</strong>
            </div>
          </div>

          {/* Monto final en toda la fila */}
          <div className="md:col-span-3 mt-3">
            <div className="p-3 bg-blue-50 border border-blue-200 rounded text-center font-semibold text-lg">
              Monto final (ventas − gastos − débitos + créditos − comisión
              vendedores):{" "}
              <span className="text-blue-700">{money(totals.finalAmount)}</span>
            </div>
          </div>
        </div>

        {/* Acciones */}
        <div className="flex items-center gap-2">
          <button
            disabled={creating}
            onClick={createInvoice}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-60"
          >
            {creating ? "Creando…" : "Crear factura"}
          </button>
          <button onClick={onClose} className="px-4 py-2 border rounded">
            Cancelar
          </button>
          {msg && <span className="text-sm ml-2">{msg}</span>}
        </div>

        {/* Overlay de carga */}
        {creating && (
          <div className="absolute inset-0 z-[11000] bg-white/80 backdrop-blur-sm flex flex-col items-center justify-center gap-3">
            <svg
              className="animate-spin h-8 w-8 text-blue-600"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
              />
            </svg>
            <div className="text-sm font-medium text-blue-700">
              Creando factura…
            </div>
          </div>
        )}
      </div>

      {/* Modal de creación de cargo */}
      {openAdjModal && (
        <div className="fixed inset-0 z-[10000] bg-black/50 flex items-center justify-center p-3">
          <div className="bg_WHITE w-full max-w-lg rounded-xl shadow-xl p-4">
            <div className="flex items-center mb-3">
              <h4 className="font-semibold">Nuevo cargo</h4>
              <button
                className="ml-auto px-2 py-1 border rounded hover:bg-gray-50"
                onClick={() => setOpenAdjModal(false)}
              >
                Cerrar
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1">
                  Descripción
                </label>
                <textarea
                  className="w-full border rounded px-2 py-1 min-h-[90px]"
                  value={adjDesc}
                  onChange={(e) => setAdjDesc(e.target.value)}
                  placeholder="Detalle del cargo"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium">
                    Tipo de cargo
                  </label>
                  <select
                    className="w-full border rounded px-2 py-1"
                    value={adjType}
                    onChange={(e) =>
                      setAdjType(e.target.value as "DEBITO" | "CREDITO")
                    }
                  >
                    <option value="DEBITO">Débito</option>
                    <option value="CREDITO">Crédito</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium">Monto</label>
                  <input
                    type="number"
                    step="0.01"
                    className="w-full border rounded px-2 py-1"
                    value={adjAmount}
                    onChange={(e) => setAdjAmount(e.target.value)}
                    placeholder="0.00"
                  />
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  className="px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                  onClick={addAdjustment}
                >
                  Agregar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
