export const PRICING_MENU = [
  { slug: "ranking", label: "Precios" },
  { slug: "rentabilidad", label: "Dashboard de rentabilidad" },
  { slug: "inventarios", label: "Inventarios" },
  { slug: "ventas", label: "Ventas" },
  { slug: "comisiones", label: "Comisiones" },
  { slug: "ventas-comisiones", label: "Ventas y Comisiones" },
  { slug: "productos", label: "Rentabilidad por producto" },
  { slug: "comparacion", label: "Comparación de inventarios" },
  { slug: "simulador", label: "Simulador de precios" },
  { slug: "historial", label: "Historial de cambios" },
] as const;

export function pricingHref(base: string, slug: string): string {
  return `${base}/pricingSystem/${slug}`;
}
