// src/lib/decimal.ts

export const QTY_PREC = 3; // decimales a usar (3 para libras/unidades)
export const EPS = 0.5 * 10 ** -QTY_PREC; // tolerancia = 0.0005

// Redondea cualquier número a 3 decimales exactos
export function roundQty(n: number): number {
  const x = Number(n ?? 0);
  return Number(x.toFixed(QTY_PREC));
}

// Suma con redondeo
export function addQty(a: number, b: number): number {
  return roundQty((a ?? 0) + (b ?? 0));
}

// Resta con redondeo
export function subQty(a: number, b: number): number {
  return roundQty((a ?? 0) - (b ?? 0));
}

// Comparación con tolerancia
export function gteQty(a: number, b: number): boolean {
  return roundQty(a) + EPS >= roundQty(b);
}
