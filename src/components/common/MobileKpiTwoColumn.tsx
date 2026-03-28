import React from "react";

export type MobileKpiColumnVariant = "emerald" | "indigo" | "rose" | "amber" | "sky";

const VARIANT_STYLES: Record<
  MobileKpiColumnVariant,
  {
    cell: string;
    badge: string;
    value: string;
    hint: string;
  }
> = {
  emerald: {
    cell: "bg-gradient-to-b from-emerald-50 to-emerald-100/70 border border-emerald-300/60",
    badge: "bg-emerald-600/90",
    value: "text-emerald-950",
    hint: "text-emerald-800/80",
  },
  indigo: {
    cell: "bg-gradient-to-b from-indigo-50 to-indigo-100/70 border border-indigo-300/60",
    badge: "bg-indigo-600/90",
    value: "text-indigo-950",
    hint: "text-indigo-800/80",
  },
  rose: {
    cell: "bg-gradient-to-b from-rose-50 to-rose-100/70 border border-rose-300/60",
    badge: "bg-rose-600/90",
    value: "text-rose-950",
    hint: "text-rose-800/80",
  },
  amber: {
    cell: "bg-gradient-to-b from-amber-50 to-amber-100/70 border border-amber-300/60",
    badge: "bg-amber-600/90",
    value: "text-amber-950",
    hint: "text-amber-800/80",
  },
  sky: {
    cell: "bg-gradient-to-b from-sky-50 to-sky-100/70 border border-sky-300/60",
    badge: "bg-sky-600/90",
    value: "text-sky-950",
    hint: "text-sky-800/80",
  },
};

export type MobileKpiColumnProps = {
  badge: string;
  value: React.ReactNode;
  subtitle?: string;
  variant?: MobileKpiColumnVariant;
};

type Props = {
  left: MobileKpiColumnProps;
  right: MobileKpiColumnProps;
  className?: string;
};

/**
 * KPI móvil de dos columnas con fondos en gradiente y badges (estilo alineado a clientes Pollo / estado de cuenta).
 */
export default function MobileKpiTwoColumn({
  left,
  right,
  className = "",
}: Props) {
  const L = VARIANT_STYLES[left.variant ?? "emerald"];
  const R = VARIANT_STYLES[right.variant ?? "indigo"];

  const renderCol = (
    col: MobileKpiColumnProps,
    styles: (typeof VARIANT_STYLES)["emerald"],
  ) => (
    <div
      className={`flex flex-col items-stretch justify-center rounded-xl px-3 py-3 shadow-inner ${styles.cell}`}
    >
      <span
        className={`inline-flex self-center rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shadow-sm ${styles.badge}`}
      >
        {col.badge}
      </span>
      <span
        className={`text-center text-lg font-bold mt-2 tabular-nums ${styles.value}`}
      >
        {col.value}
      </span>
      {col.subtitle ? (
        <span
          className={`text-[10px] text-center mt-1 leading-snug ${styles.hint}`}
        >
          {col.subtitle}
        </span>
      ) : null}
    </div>
  );

  return (
    <div
      className={`rounded-2xl border-2 border-slate-200/90 bg-gradient-to-br from-white via-slate-50/40 to-white p-4 shadow-md ${className}`.trim()}
    >
      <div className="grid grid-cols-2 gap-3">
        {renderCol(left, L)}
        {renderCol(right, R)}
      </div>
    </div>
  );
}
