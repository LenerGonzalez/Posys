import React from "react";
import Button from "./Button";

export type PolloMobileKpiCardVariant =
  | "white"
  | "gray"
  | "emerald"
  | "violet"
  | "indigo"
  | "dark";

const SHELL: Record<PolloMobileKpiCardVariant, string> = {
  white: "border rounded-2xl p-3 bg-white shadow-sm",
  gray: "border rounded-2xl p-3 bg-gray-50",
  emerald: "rounded-xl p-3 bg-emerald-50 border border-emerald-200 shadow-sm",
  violet: "rounded-xl p-3 bg-violet-50 border border-violet-200 shadow-sm",
  indigo:
    "flex flex-col items-stretch w-full h-auto !rounded-2xl border border-indigo-200/80 p-3 bg-indigo-50 text-left hover:ring-2 hover:ring-indigo-300 transition-shadow !font-normal shadow-sm",
  dark: "border rounded-2xl p-3 bg-gray-900 text-white",
};

export type PolloMobileKpiCardProps = {
  /** Texto superior (etiqueta) */
  label: React.ReactNode;
  /** Valor principal */
  value: React.ReactNode;
  variant?: PolloMobileKpiCardVariant;
  /** Texto secundario opcional bajo la etiqueta */
  hint?: React.ReactNode;
  /** Acción opcional (ej. “ver detalle →”) */
  actionSlot?: React.ReactNode;
  /** Botón compacto tipo “Ver indicadores / Ocultar” */
  toggleButton?: {
    expanded: boolean;
    onClick: () => void;
    showLabel: string;
    hideLabel: string;
  };
  className?: string;
  /** Si el shell es botón (p. ej. KPIs clicables) */
  onClick?: () => void;
  role?: "button";
  tabIndex?: number;
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
};

/**
 * Tarjeta KPI reutilizable para layout móvil (Pollo / caja), alineada con StatusAccount.
 */
export default function PolloMobileKpiCard({
  label,
  value,
  variant = "white",
  hint,
  actionSlot,
  toggleButton,
  className = "",
  onClick,
  role,
  tabIndex,
  onKeyDown,
}: PolloMobileKpiCardProps) {
  const shell = `${SHELL[variant]} ${className}`.trim();

  const inner = (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-gray-600 min-w-0">{label}</div>
        {toggleButton ? (
          <Button
            type="button"
            variant={toggleButton.expanded ? "primary" : "secondary"}
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              toggleButton.onClick();
            }}
            className={`!rounded-xl shrink-0 text-xs !px-2.5 !py-1.5 !font-medium ${
              toggleButton.expanded
                ? ""
                : "!bg-gray-100 !text-gray-800 hover:!bg-gray-200"
            }`}
          >
            {toggleButton.expanded ? toggleButton.hideLabel : toggleButton.showLabel}
          </Button>
        ) : null}
      </div>
      {hint ? (
        <div className="text-xs text-gray-500 mt-0.5">{hint}</div>
      ) : null}
      {actionSlot ? (
        <div className="mt-1 flex items-start justify-between gap-2">{actionSlot}</div>
      ) : null}
      <div
        className={
          variant === "dark"
            ? "text-3xl font-extrabold mt-1"
            : variant === "indigo"
              ? "text-2xl font-bold mt-2"
              : "text-lg font-bold mt-2"
        }
      >
        {value}
      </div>
    </>
  );

  if (onClick && role === "button") {
    return (
      <button
        type="button"
        className={`${shell} w-full text-left cursor-pointer`}
        onClick={onClick}
        tabIndex={tabIndex ?? 0}
        onKeyDown={onKeyDown}
      >
        {inner}
      </button>
    );
  }

  return <div className={shell}>{inner}</div>;
}
