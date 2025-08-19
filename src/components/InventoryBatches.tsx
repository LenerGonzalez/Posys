// src/components/InventoryBatches.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  collection,
  getDocs,
  orderBy,
  query,
  updateDoc,
  deleteDoc,
  doc,
} from "firebase/firestore";
import { db } from "../firebase";
import { newBatch, markBatchAsPaid } from "../Services/inventory";
import { Timestamp } from "firebase/firestore";
import { format } from "date-fns";

const money = (n: number) => `C$${(Number(n) || 0).toFixed(2)}`;

interface Product {
  id: string;
  name: string;
  category: string;
  measurement: string;
  price: number;
}

interface Batch {
  id: string;
  productId: string;
  productName: string;
  category: string;
  unit: string;
  quantity: number;
  remaining: number;
  purchasePrice: number;
  salePrice: number;
  invoiceTotal?: number;
  expectedTotal?: number;
  date: string; // yyyy-MM-dd
  createdAt: Timestamp;
  status: "PENDIENTE" | "PAGADO";
  notes?: string;
  paidAmount?: number;
  paidAt?: Timestamp;
}

export default function InventoryBatches() {
  const [products, setProducts] = useState<Product[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  // form (crear)
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState<number>(0);
  const [purchasePrice, setPurchasePrice] = useState<number>(0);
  const [salePrice, setSalePrice] = useState<number>(0);
  const [dateStr, setDateStr] = useState<string>(
    format(new Date(), "yyyy-MM-dd")
  );
  const [invoiceTotal, setInvoiceTotal] = useState<number>(0);
  const [expectedTotal, setExpectedTotal] = useState<number>(0);
  const [notes, setNotes] = useState<string>("");

  // edición en tabla (por lote)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState<string>("");
  const [editQty, setEditQty] = useState<number>(0);
  const [editPurchase, setEditPurchase] = useState<number>(0);
  const [editSale, setEditSale] = useState<number>(0);
  const [editNotes, setEditNotes] = useState<string>("");
  const [editInvoiceTotal, setEditInvoiceTotal] = useState<number>(0);
  const [editExpectedTotal, setEditExpectedTotal] = useState<number>(0);

  useEffect(() => {
    (async () => {
      // cargar products
      const psnap = await getDocs(collection(db, "products"));
      const prods: Product[] = [];
      psnap.forEach((d) => {
        const it = d.data() as any;
        prods.push({
          id: d.id,
          name: it.name ?? it.productName ?? "(sin nombre)",
          category: it.category ?? "(sin categoría)",
          measurement: it.measurement ?? "lb",
          price: Number(it.price ?? 0),
        });
      });
      setProducts(prods);

      // cargar batches
      const qB = query(
        collection(db, "inventory_batches"),
        orderBy("date", "desc")
      );
      const bsnap = await getDocs(qB);
      const rows: Batch[] = [];
      bsnap.forEach((d) => {
        const b = d.data() as any;
        rows.push({
          id: d.id,
          productId: b.productId,
          productName: b.productName,
          category: b.category,
          unit: b.unit,
          quantity: Number(b.quantity || 0),
          remaining: Number(b.remaining || 0),
          purchasePrice: Number(b.purchasePrice || 0),
          salePrice: Number(b.salePrice || 0),
          invoiceTotal: Number(b.invoiceTotal || 0),
          expectedTotal: Number(
            b.expectedTotal ??
              (Number(b.quantity || 0) * Number(b.salePrice || 0) || 0)
          ),
          date: b.date,
          createdAt: b.createdAt,
          status: b.status,
          notes: b.notes,
          paidAmount: Number(b.paidAmount || 0),
          paidAt: b.paidAt,
        });
      });
      setBatches(rows);
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    // sugerir salePrice del producto elegido
    const p = products.find((x) => x.id === productId);
    if (p) setSalePrice(Number(p.price || 0));
  }, [productId, products]);

  // cálculos automáticos (crear)
  useEffect(() => {
    setInvoiceTotal(Math.floor(quantity * purchasePrice * 100) / 100);
  }, [quantity, purchasePrice]);
  useEffect(() => {
    setExpectedTotal(Math.floor(quantity * salePrice * 100) / 100);
  }, [quantity, salePrice]);

  const totals = useMemo(() => {
    const qty = batches.reduce((a, b) => a + b.quantity, 0);
    const rem = batches.reduce((a, b) => a + b.remaining, 0);
    return { qty, rem };
  }, [batches]);

  const saveBatch = async (e: React.FormEvent) => {
    e.preventDefault();
    const p = products.find((x) => x.id === productId);
    if (!p || quantity <= 0 || purchasePrice <= 0) {
      setMsg("Completa producto, cantidad y costo.");
      return;
    }
    try {
      const ref = await newBatch({
        productId: p.id,
        productName: p.name,
        category: p.category,
        unit: p.measurement,
        quantity,
        purchasePrice,
        salePrice,
        invoiceTotal, // calculado auto
        expectedTotal, // nuevo campo
        date: dateStr,
        notes,
      });
      setBatches((prev) => [
        {
          id: ref.id,
          productId: p.id,
          productName: p.name,
          category: p.category,
          unit: p.measurement,
          quantity,
          remaining: quantity,
          purchasePrice,
          salePrice,
          invoiceTotal,
          expectedTotal,
          date: dateStr,
          createdAt: Timestamp.now(),
          status: "PENDIENTE",
          notes,
        },
        ...prev,
      ]);
      setMsg("✅ Lote creado");
      setProductId("");
      setQuantity(0);
      setPurchasePrice(0);
      setSalePrice(p.price || 0);
      setInvoiceTotal(0);
      setExpectedTotal(0);
      setNotes("");
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al crear lote");
    }
  };

  const payBatch = async (b: Batch) => {
    const ok = confirm(
      `Marcar PAGADO el lote del ${b.date} (${b.productName})?`
    );
    if (!ok) return;
    await markBatchAsPaid(b.id);
    setBatches((prev) =>
      prev.map((x) => (x.id === b.id ? { ...x, status: "PAGADO" } : x))
    );
  };

  // ====== Editar / Eliminar lote ======
  const startEdit = (b: Batch) => {
    setEditingId(b.id);
    setEditDate(b.date);
    setEditQty(b.quantity);
    setEditPurchase(b.purchasePrice);
    setEditSale(b.salePrice);
    setEditNotes(b.notes || "");
    setEditInvoiceTotal(Number((b.quantity * b.purchasePrice).toFixed(2)));
    setEditExpectedTotal(Number((b.quantity * b.salePrice).toFixed(2)));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDate("");
    setEditQty(0);
    setEditPurchase(0);
    setEditSale(0);
    setEditNotes("");
    setEditInvoiceTotal(0);
    setEditExpectedTotal(0);
  };

  // recalcular totales en edición
  useEffect(() => {
    if (!editingId) return;
    setEditInvoiceTotal(Math.floor(editQty * editPurchase * 100) / 100);
  }, [editingId, editQty, editPurchase]);
  useEffect(() => {
    if (!editingId) return;
    setEditExpectedTotal(Math.floor(editQty * editSale * 100) / 100);
  }, [editingId, editQty, editSale]);

  const saveEdit = async () => {
    if (!editingId) return;

    // Recalcular remaining conservando lo ya consumido
    const old = batches.find((x) => x.id === editingId);
    if (!old) return;
    const consumido = old.quantity - old.remaining; // lo ya vendido/salido
    const newRemaining = Math.max(0, editQty - consumido); // evita negativos

    const ref = doc(db, "inventory_batches", editingId);
    await updateDoc(ref, {
      date: editDate,
      quantity: editQty,
      purchasePrice: editPurchase,
      salePrice: editSale,
      invoiceTotal: editInvoiceTotal,
      expectedTotal: editExpectedTotal,
      notes: editNotes,
      remaining: newRemaining,
    });

    setBatches((prev) =>
      prev.map((x) =>
        x.id === editingId
          ? {
              ...x,
              date: editDate,
              quantity: editQty,
              purchasePrice: editPurchase,
              salePrice: editSale,
              invoiceTotal: editInvoiceTotal,
              expectedTotal: editExpectedTotal,
              notes: editNotes,
              remaining: newRemaining,
            }
          : x
      )
    );
    cancelEdit();
    setMsg("✅ Lote actualizado");
  };

  const deleteBatch = async (b: Batch) => {
    const ok = confirm(`¿Eliminar el lote del ${b.date} (${b.productName})?`);
    if (!ok) return;
    await deleteDoc(doc(db, "inventory_batches", b.id));
    setBatches((prev) => prev.filter((x) => x.id !== b.id));
    setMsg("🗑️ Lote eliminado");
  };
  // ====== FIN edición/eliminación ======

  return (
    <div className="max-w-6xl mx-auto">
      <h2 className="text-2xl font-bold mb-3">Inventario por Lotes</h2>

      {/* Form nuevo lote */}
      <form
        onSubmit={saveBatch}
        className="bg-white p-4 rounded shadow border mb-6 grid grid-cols-1 md:grid-cols-2 gap-4"
      >
        <div className="md:col-span-2">
          <label className="block text-sm font-semibold">Producto</label>
          <select
            className="w-full border p-2 rounded"
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
          >
            <option value="">Selecciona un producto</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.category} — {p.measurement} — Precio:{" "}
                {money(p.price)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-semibold">Fecha del lote</label>
          <input
            type="date"
            className="w-full border p-2 rounded"
            value={dateStr}
            onChange={(e) => setDateStr(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-sm font-semibold">
            Cantidad (ingreso)
          </label>
          <input
            type="text"
            inputMode="decimal"
            pattern="^[0-9]*[.]?[0-9]*$"
            className="w-full border p-2 rounded"
            value={quantity || ""}
            onChange={(e) =>
              setQuantity(
                Math.floor(
                  (parseFloat(e.target.value.replace(",", ".")) || 0) * 100
                ) / 100
              )
            }
          />
        </div>

        <div>
          <label className="block text-sm font-semibold">
            Costo unitario (compra)
          </label>
          <input
            type="text"
            inputMode="decimal"
            pattern="^[0-9]*[.]?[0-9]*$"
            className="w-full border p-2 rounded"
            value={purchasePrice || ""}
            onChange={(e) =>
              setPurchasePrice(
                Math.floor(
                  (parseFloat(e.target.value.replace(",", ".")) || 0) * 100
                ) / 100
              )
            }
          />
        </div>

        <div>
          <label className="block text-sm font-semibold">
            Precio unitario (venta ref.)
          </label>
          <input
            type="text"
            inputMode="decimal"
            pattern="^[0-9]*[.]?[0-9]*$"
            className="w-full border p-2 rounded"
            value={salePrice || ""}
            onChange={(e) =>
              setSalePrice(
                Math.floor(
                  (parseFloat(e.target.value.replace(",", ".")) || 0) * 100
                ) / 100
              )
            }
          />
        </div>

        {/* campos calculados */}
        <div>
          <label className="block text-sm font-semibold">
            Total factura (auto)
          </label>
          <input
            type="text"
            className="w-full border p-2 rounded bg-gray-100"
            value={money(invoiceTotal)}
            readOnly
          />
        </div>

        <div>
          <label className="block text-sm font-semibold">
            Total esperado (auto)
          </label>
          <input
            type="text"
            className="w-full border p-2 rounded bg-gray-100"
            value={money(expectedTotal)}
            readOnly
          />
        </div>

        <div className="md:col-span-2">
          <label className="block text-sm font-semibold">Notas</label>
          <input
            className="w-full border p-2 rounded"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div className="md:col-span-2">
          <button className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
            Guardar lote
          </button>
        </div>
      </form>

      {/* Totales */}
      <div className="bg-white p-3 rounded shadow border mb-3 text-sm">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <div>
            <span className="font-semibold">Libras/Unidades ingresadas:</span>{" "}
            {totals.qty}
          </div>
          <div>
            <span className="font-semibold">Restantes (abiertas):</span>{" "}
            {totals.rem}
          </div>
        </div>
      </div>

      {/* Tabla de lotes */}
      <div className="bg-white p-2 rounded shadow border overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-2 border">Fecha</th>
              <th className="p-2 border">Producto</th>
              <th className="p-2 border">Cat.</th>
              <th className="p-2 border">Unidad</th>
              <th className="p-2 border">Ingresado</th>
              <th className="p-2 border">Remaining</th>
              <th className="p-2 border">Costo</th>
              <th className="p-2 border">Venta ref</th>
              <th className="p-2 border">Total factura</th>
              <th className="p-2 border">Total esperado</th>
              <th className="p-2 border">Estado</th>
              <th className="p-2 border">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={12} className="p-4 text-center">
                  Cargando…
                </td>
              </tr>
            ) : batches.length === 0 ? (
              <tr>
                <td colSpan={12} className="p-4 text-center">
                  Sin lotes
                </td>
              </tr>
            ) : (
              batches.map((b) => {
                const isEditing = editingId === b.id;
                return (
                  <tr key={b.id} className="text-center">
                    <td className="p-2 border">
                      {isEditing ? (
                        <input
                          type="date"
                          className="w-full border p-1 rounded"
                          value={editDate}
                          onChange={(e) => setEditDate(e.target.value)}
                        />
                      ) : (
                        b.date
                      )}
                    </td>
                    <td className="p-2 border">{b.productName}</td>
                    <td className="p-2 border">{b.category}</td>
                    <td className="p-2 border">{b.unit}</td>
                    <td className="p-2 border">
                      {isEditing ? (
                        <input
                          className="w-full border p-1 rounded text-right"
                          inputMode="decimal"
                          value={Number.isNaN(editQty) ? "" : editQty}
                          onChange={(e) =>
                            setEditQty(
                              Math.floor(
                                (parseFloat(e.target.value.replace(",", ".")) ||
                                  0) * 100
                              ) / 100
                            )
                          }
                        />
                      ) : (
                        b.quantity
                      )}
                    </td>
                    <td className="p-2 border">{b.remaining}</td>
                    <td className="p-2 border">
                      {isEditing ? (
                        <input
                          className="w-full border p-1 rounded text-right"
                          inputMode="decimal"
                          value={Number.isNaN(editPurchase) ? "" : editPurchase}
                          onChange={(e) =>
                            setEditPurchase(
                              Math.floor(
                                (parseFloat(e.target.value.replace(",", ".")) ||
                                  0) * 100
                              ) / 100
                            )
                          }
                        />
                      ) : (
                        money(b.purchasePrice)
                      )}
                    </td>
                    <td className="p-2 border">
                      {isEditing ? (
                        <input
                          className="w-full border p-1 rounded text-right"
                          inputMode="decimal"
                          value={Number.isNaN(editSale) ? "" : editSale}
                          onChange={(e) =>
                            setEditSale(
                              Math.floor(
                                (parseFloat(e.target.value.replace(",", ".")) ||
                                  0) * 100
                              ) / 100
                            )
                          }
                        />
                      ) : (
                        money(b.salePrice)
                      )}
                    </td>
                    <td className="p-2 border">
                      {isEditing
                        ? money(editInvoiceTotal)
                        : money(b.invoiceTotal || 0)}
                    </td>
                    <td className="p-2 border">
                      {isEditing
                        ? money(editExpectedTotal)
                        : money(b.expectedTotal || 0)}
                    </td>
                    <td className="p-2 border">
                      <span
                        className={`px-2 py-0.5 rounded text-xs ${
                          b.status === "PAGADO"
                            ? "bg-green-100 text-green-700"
                            : "bg-yellow-100 text-yellow-700"
                        }`}
                      >
                        {b.status}
                      </span>
                    </td>
                    <td className="p-2 border space-x-2">
                      {isEditing ? (
                        <>
                          <button
                            className="px-2 py-1 rounded text-white bg-blue-600 hover:bg-blue-700"
                            onClick={saveEdit}
                          >
                            Guardar
                          </button>
                          <button
                            className="px-2 py-1 rounded bg-gray-200 hover:bg-gray-300"
                            onClick={cancelEdit}
                          >
                            Cancelar
                          </button>
                        </>
                      ) : (
                        <>
                          {b.status === "PENDIENTE" && (
                            <button
                              onClick={() => payBatch(b)}
                              className="px-2 py-1 rounded text-white bg-green-600 hover:bg-green-700"
                            >
                              Marcar pagado
                            </button>
                          )}
                          <button
                            className="px-2 py-1 rounded text-white bg-yellow-600 hover:bg-yellow-700"
                            onClick={() => startEdit(b)}
                          >
                            Editar
                          </button>
                          <button
                            className="px-2 py-1 rounded text-white bg-red-600 hover:bg-red-700"
                            onClick={() => deleteBatch(b)}
                          >
                            Eliminar
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {msg && <p className="mt-2 text-sm">{msg}</p>}
    </div>
  );
}
