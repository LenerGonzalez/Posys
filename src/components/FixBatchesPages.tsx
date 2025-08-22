// src/components/FixBatchesPage.tsx
import React, { useState } from "react";
import {
  fixAllBatchProductIds,
  fixBatchesByProductName,
} from "../Services/fixAllBatchProductIds";

export default function FixBatchesPage() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");

  const runAll = async () => {
    try {
      setBusy(true);
      setMsg("");
      const res = await fixAllBatchProductIds(false); // false => escribe cambios
      setMsg(
        `✅ Hecho. Revisados: ${res.checked}, Corregidos: ${res.fixed}, Ok: ${res.alreadyOk}, ` +
          `Sin nombre: ${res.missingName}, Sin match: ${res.withoutMatch}. (Mira consola para detalles)`
      );
    } catch (e: any) {
      setMsg("❌ Error: " + (e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const [singleName, setSingleName] = useState("");
  const runSingle = async () => {
    if (!singleName.trim()) {
      setMsg("⚠️ Escribe el nombre del producto.");
      return;
    }
    try {
      setBusy(true);
      setMsg("");
      const n = await fixBatchesByProductName(singleName.trim(), false);
      setMsg(`✅ Hecho. Corregidos ${n} lote(s) para "${singleName}".`);
    } catch (e: any) {
      setMsg("❌ Error: " + (e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto bg-white p-6 rounded shadow border space-y-4">
      <h1 className="text-xl font-bold">Herramienta de Migración de Lotes</h1>
      <p className="text-sm text-gray-600">
        Corrige los <code>inventory_batches.productId</code> basándose en el
        nombre del producto. Úsalo una sola vez para limpiar datos viejos.
        Revisa la consola para un log detallado.
      </p>

      <div className="space-y-2">
        <button
          onClick={runAll}
          disabled={busy}
          className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-60"
        >
          {busy ? "Corriendo…" : "Corregir TODOS los lotes"}
        </button>
      </div>

      <hr />

      <div className="space-y-2">
        <label className="block text-sm font-medium">
          Corregir por nombre:
        </label>
        <input
          className="border p-2 rounded w-full"
          placeholder='Ej: "Pierna Entera"'
          value={singleName}
          onChange={(e) => setSingleName(e.target.value)}
        />
        <button
          onClick={runSingle}
          disabled={busy}
          className="bg-indigo-600 text-white px-4 py-2 rounded disabled:opacity-60"
        >
          {busy ? "Corriendo…" : "Corregir lotes de ese producto"}
        </button>
      </div>

      {msg && <p className="text-sm">{msg}</p>}
    </div>
  );
}
