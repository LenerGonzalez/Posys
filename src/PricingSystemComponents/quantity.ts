import { qty } from "./format";
import { eachLabel, productMeasureUnit, quantityNoun, type MeasureUnit, type ProductInput } from "./types";

/** 1 unidad de cantidad = 1000 milésimas. 1.5 lb = 1500. */
export const QUANTITY_SCALE = 1000;

export type QuantityReading =
  | { ok: true; milli: number }
  | { ok: false; error: string };

function amountToMilli(value: unknown): "absent" | "invalid" | number {
  if (value == null) return "absent";
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "invalid";
  const milli = milliFromAmount(value);
  return milli == null ? "invalid" : milli;
}

function storedInteger(value: unknown): "absent" | "invalid" | number {
  if (value === undefined) return "absent";
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  return "invalid";
}

/**
 * Lee una cantidad una sola vez.
 * `quantityMilli` es el total. El entero solo se usa si no hay milésimas,
 * o para comprobar que dice exactamente lo mismo. Nunca se suman.
 */
export function readMilliPair(input: {
  whole?: unknown;
  quantityMilli?: unknown;
  unit?: unknown;
  allowFraction?: boolean;
}): QuantityReading {
  const unit = productMeasureUnit(input);
  const whole = amountToMilli(input.whole);
  const quantityMilli = storedInteger(input.quantityMilli);
  if (whole === "invalid" || quantityMilli === "invalid") {
    return { ok: false, error: "La cantidad no es válida." };
  }
  if (whole === "absent" && quantityMilli === "absent") {
    return { ok: false, error: "La cantidad no es válida." };
  }
  let milli: number;
  if (quantityMilli !== "absent") {
    if (whole !== "absent" && whole !== quantityMilli) {
      return { ok: false, error: "La cantidad no coincide." };
    }
    milli = quantityMilli;
  } else if (whole !== "absent") {
    milli = whole;
  } else {
    return { ok: false, error: "La cantidad no es válida." };
  }
  if (!Number.isInteger(milli) || milli < 0) {
    return { ok: false, error: "La cantidad no es válida." };
  }
  if (!input.allowFraction && unit !== "lb" && milli % QUANTITY_SCALE !== 0) {
    return { ok: false, error: "Esta unidad solo admite cantidades enteras." };
  }
  return { ok: true, milli };
}

export function readQuantityMilli(product: {
  unit?: unknown;
  packages?: unknown;
  quantityMilli?: unknown;
}): QuantityReading {
  return readMilliPair({ whole: product.packages, quantityMilli: product.quantityMilli, unit: product.unit });
}

export function readSoldMilli(balance: {
  soldPackages?: unknown;
  quantityMilli?: unknown;
}): QuantityReading {
  if (balance.soldPackages == null && balance.quantityMilli == null) return { ok: true, milli: 0 };
  return readMilliPair({
    whole: balance.soldPackages,
    quantityMilli: balance.quantityMilli,
    allowFraction: true,
  });
}

export function readSaleMilli(line: {
  quantity?: unknown;
  quantityMilli?: unknown;
  unit?: unknown;
}): QuantityReading {
  return readMilliPair({ whole: line.quantity, quantityMilli: line.quantityMilli, unit: line.unit });
}

export function productQuantity(product: {
  unit?: unknown;
  packages?: unknown;
  quantityMilli?: unknown;
}): number | null {
  const reading = readQuantityMilli(product);
  return reading.ok ? reading.milli / QUANTITY_SCALE : null;
}

/** Convierte un monto con hasta tres decimales a milésimas. No trunca. */
export function milliFromAmount(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const scaled = value * QUANTITY_SCALE;
  const milli = Math.round(scaled);
  if (!Number.isInteger(milli) || milli < 0 || Math.abs(scaled - milli) > 1e-4) return null;
  return milli;
}

/** Entero en `packages`. Decimal de libra solo en `quantityMilli`. */
export function storedQuantity(
  unit: MeasureUnit,
  milli: number,
): { packages: number } | { quantityMilli: number } | null {
  if (!Number.isInteger(milli) || milli < 0) return null;
  if (unit !== "lb" && milli % QUANTITY_SCALE !== 0) return null;
  if (milli % QUANTITY_SCALE === 0) return { packages: milli / QUANTITY_SCALE };
  return { quantityMilli: milli };
}

export function storedSoldCounter(milli: number): { soldPackages: number } | { quantityMilli: number } | null {
  const stored = storedQuantity("lb", milli);
  if (!stored) return null;
  if ("packages" in stored) return { soldPackages: stored.packages };
  return stored;
}

export function storedSaleLine(
  unit: MeasureUnit,
  milli: number,
): { unit: MeasureUnit; quantity: number } | { unit: MeasureUnit; quantityMilli: number } | null {
  const stored = storedQuantity(unit, milli);
  if (!stored || milli <= 0) return null;
  if ("packages" in stored) return { unit, quantity: stored.packages };
  return { unit, quantityMilli: stored.quantityMilli };
}

export function withStoredQuantity(product: ProductInput, milli: number): ProductInput | null {
  const stored = storedQuantity(productMeasureUnit(product), milli);
  if (!stored) return null;
  const next: ProductInput = { ...product };
  delete next.packages;
  delete next.quantityMilli;
  return { ...next, ...stored };
}

/** Copia los campos presentes sin inventar `packages: 0` ni `quantityMilli`. */
export function takeStoredQuantity(row: {
  packages?: unknown;
  quantityMilli?: unknown;
}): { packages?: number; quantityMilli?: number } {
  const fields: { packages?: number; quantityMilli?: number } = {};
  if (row.packages != null && row.packages !== "") {
    const packages = Number(row.packages);
    if (Number.isFinite(packages)) fields.packages = packages;
  }
  if (row.quantityMilli != null && row.quantityMilli !== "") {
    const quantityMilli = Number(row.quantityMilli);
    if (Number.isFinite(quantityMilli)) fields.quantityMilli = quantityMilli;
  }
  return fields;
}

export function totalsByUnit(lines: Array<{ quantity?: unknown; quantityMilli?: unknown; unit?: unknown }>): Array<{ unit: MeasureUnit; amount: number }> {
  const totals = new Map<MeasureUnit, number>();
  for (const line of lines) {
    const reading = readSaleMilli(line);
    if (!reading.ok || reading.milli <= 0) continue;
    const unit = productMeasureUnit(line);
    totals.set(unit, (totals.get(unit) || 0) + reading.milli);
  }
  return (["package", "lb", "unit"] as const)
    .filter((unit) => totals.has(unit))
    .map((unit) => ({ unit, amount: (totals.get(unit) || 0) / QUANTITY_SCALE }));
}

export function formatQuantityTotals(lines: Array<{ quantity?: unknown; quantityMilli?: unknown; unit?: unknown }>): string {
  const totals = totalsByUnit(lines);
  if (!totals.length) return "0";
  return totals
    .map(({ unit, amount }) => `${qty(amount)} ${amount === 1 ? eachLabel(unit) : quantityNoun(unit)}`)
    .join(" · ");
}
