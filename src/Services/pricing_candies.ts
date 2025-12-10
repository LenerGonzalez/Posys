// src/Services/pricing_candies.ts

// Sucursales que ya usás en el POS
export type Branch = "RIVAS" | "SAN_JORGE" | "ISLA";

// 🔹 Factores de ganancia por sucursal
// Rivas: 25% → factor 0.75
// San Jorge: 25% → factor 0.75
// Isla: 30% → factor 0.70
export const BRANCH_FACTORS: Record<Branch, number> = {
  RIVAS: 0.75,
  SAN_JORGE: 0.75,
  ISLA: 0.7,
};

// Por si en algún lado te interesa ver el % de margen desde el factor
export function getMarginPercentFromFactor(factor: number): number {
  // factor = 1 - margen
  // margen% = (1 - factor) * 100
  const f = Number(factor || 0);
  if (f <= 0 || f >= 1) return 0;
  return (1 - f) * 100;
}

// Obtener el factor de una sucursal (con fallback seguro)
export function getFactorByBranch(branch: Branch): number {
  return BRANCH_FACTORS[branch] ?? 1;
}

// 🔹 Cálculo base: precio desde costo y factor
export function calcPriceFromCostAndFactor(
  cost: number,
  factor: number
): number {
  const c = Number(cost || 0);
  const f = Number(factor || 0);

  if (c <= 0 || f <= 0) return 0;

  // precioVenta = costo / factor
  const price = c / f;
  // si querés más precisión podés usar toFixed(2)
  return Number(price.toFixed(2));
}

// 🔹 Cálculo directo por sucursal
export function calcPriceByBranch(cost: number, branch: Branch): number {
  const factor = getFactorByBranch(branch);
  return calcPriceFromCostAndFactor(cost, factor);
}
