import React from "react";

export type PolloChipVariant =
  | "neutral"
  | "emerald"
  | "violet"
  | "sky"
  | "amber"
  | "rose"
  | "slate";

const VARIANT: Record<
  PolloChipVariant,
  string
> = {
  neutral: "bg-gray-100 text-gray-800 border-gray-200",
  emerald: "bg-emerald-100 text-emerald-900 border-emerald-200",
  violet: "bg-violet-100 text-violet-900 border-violet-200",
  sky: "bg-sky-100 text-sky-900 border-sky-200",
  amber: "bg-amber-100 text-amber-900 border-amber-200",
  rose: "bg-rose-100 text-rose-900 border-rose-200",
  slate: "bg-slate-100 text-slate-800 border-slate-200",
};

export type PolloChipProps = {
  children: React.ReactNode;
  variant?: PolloChipVariant;
  className?: string;
  title?: string;
};

/**
 * Chip compacto reutilizable (Pollo / inventario / caja).
 */
export default function PolloChip({
  children,
  variant = "neutral",
  className = "",
  title,
}: PolloChipProps) {
  return (
    <span
      title={title}
      className={`inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${VARIANT[variant]} ${className}`.trim()}
    >
      {children}
    </span>
  );
}
