/**
 * Estado operativo del lote en `inventory_batches` (independiente de `status` PAGADO/PENDIENTE).
 * Solo lotes ACTIVO participan en ventas / FIFO.
 */
export type BatchStockStatus = "ACTIVO" | "PENDIENTE";

export function parseBatchStockStatus(raw: unknown): BatchStockStatus {
  const s = String(raw ?? "ACTIVO").toUpperCase();
  if (s === "PENDIENTE") return "PENDIENTE";
  return "ACTIVO";
}

export function isBatchStockActivo(data: { estadoStock?: unknown }): boolean {
  return parseBatchStockStatus(data.estadoStock) === "ACTIVO";
}

/** Etiqueta UI (femenino para “Activa” como pediste en badges). */
export function labelEstadoStock(s: BatchStockStatus): string {
  return s === "ACTIVO" ? "Activa" : "Pendiente";
}

export type GroupStockStatusSummary = "activa" | "pendiente" | "mixto";

export function summarizeGroupStockStatus(
  items: Array<{ estadoStock?: unknown }>,
): GroupStockStatusSummary {
  if (!items.length) return "activa";
  const set = new Set(items.map((x) => parseBatchStockStatus(x.estadoStock)));
  if (set.size === 1) {
    return set.has("PENDIENTE") ? "pendiente" : "activa";
  }
  return "mixto";
}
