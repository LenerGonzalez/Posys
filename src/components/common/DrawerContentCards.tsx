import React from "react";

/**
 * Bloques visuales compartidos con el detalle en slide-over de inventario (pollo)
 * y otros drawers que deben verse igual: rejilla gris, franja de montos y cards con dl.
 */

export type DrawerStatItem = {
  label: string;
  value: React.ReactNode;
  key?: string;
  /** Si se define, sustituye el sufijo por defecto del valor (p. ej. sin tabular-nums para texto) */
  valueClassName?: string;
};

/** Celdas KPI grises (etiqueta en mayúsculas visual) — mismo patrón que lotes en InventoryBatches */
export function DrawerStatGrid({ items }: { items: DrawerStatItem[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {items.map((it, i) => (
        <div
          key={it.key ?? `${it.label}-${i}`}
          className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2"
        >
          <div className="text-[11px] font-medium uppercase text-gray-500">
            {it.label}
          </div>
          <div
            className={`text-sm font-semibold text-gray-900 ${
              it.valueClassName ?? "tabular-nums"
            }`}
          >
            {it.value}
          </div>
        </div>
      ))}
    </div>
  );
}

export type DrawerMoneyTone = "blue" | "slate" | "emerald";

export type DrawerMoneyStripItem = {
  label: string;
  value: React.ReactNode;
  tone: DrawerMoneyTone;
};

/** Tres montos destacados (facturado / esperado / utilidad o equivalente) */
export function DrawerMoneyStrip({ items }: { items: DrawerMoneyStripItem[] }) {
  const wrap: Record<
    DrawerMoneyTone,
    { box: string; lab: string; val: string }
  > = {
    blue: {
      box: "rounded-lg border border-blue-100 bg-blue-50/80 px-3 py-2",
      lab: "text-[11px] text-blue-800",
      val: "text-base font-bold text-blue-950",
    },
    slate: {
      box: "rounded-lg border border-slate-100 bg-slate-50 px-3 py-2",
      lab: "text-[11px] text-slate-600",
      val: "text-base font-semibold text-slate-900",
    },
    emerald: {
      box: "rounded-lg border border-emerald-100 bg-emerald-50/80 px-3 py-2",
      lab: "text-[11px] text-emerald-800",
      val: "text-base font-bold text-emerald-900",
    },
  };
  return (
    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
      {items.map((it, i) => {
        const w = wrap[it.tone];
        return (
          <div key={`${it.label}-${i}`} className={w.box}>
            <div className={w.lab}>{it.label}</div>
            <div className={w.val}>{it.value}</div>
          </div>
        );
      })}
    </div>
  );
}

export function DrawerSectionTitle({
  children,
  className = "mt-4",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h3 className={`text-sm font-semibold text-gray-800 ${className}`}>
      {children}
    </h3>
  );
}

export type DrawerDlRow = {
  label: string;
  value: React.ReactNode;
  /** Si no se pasa, valor numérico/monto por defecto */
  ddClassName?: string;
};

/** Card blanca con título + rejilla dt/dd (producto / línea de venta) */
export function DrawerDetailDlCard({
  title,
  rows,
}: {
  title: React.ReactNode;
  rows: DrawerDlRow[];
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
      <div className="text-sm font-semibold text-gray-900 leading-snug">
        {title}
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
        {rows.map((r) => (
          <div key={r.label}>
            <dt className="text-[11px] text-gray-500">{r.label}</dt>
            <dd
              className={
                r.ddClassName ??
                "text-sm font-semibold tabular-nums text-gray-900"
              }
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
