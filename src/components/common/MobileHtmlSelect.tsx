import React, { useId, useMemo, useState } from "react";
import BottomSheet from "./BottomSheet";

export type MobileHtmlSelectOption = {
  value: string;
  label: string;
};

type Props = {
  /** Si se omite, no se muestra etiqueta (útil en celdas de tabla). */
  label?: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  options: MobileHtmlSelectOption[];
  disabled?: boolean;
  selectClassName?: string;
  buttonClassName?: string;
  id?: string;
  /** Título del bottom sheet en móvil (por defecto el label en string) */
  sheetTitle?: string;
};

/**
 * Select nativo en md+; en móvil botón + BottomSheet con la misma lista de opciones.
 */
export default function MobileHtmlSelect({
  label,
  value,
  onChange,
  options,
  disabled,
  selectClassName = "w-full border rounded-xl px-3 py-2 text-sm",
  buttonClassName =
    "w-full border rounded-xl px-3 py-2 text-sm text-left flex items-center justify-between gap-2 bg-white",
  id,
  sheetTitle,
}: Props) {
  const [open, setOpen] = useState(false);
  const autoId = useId();
  const lid = id ?? autoId;

  const currentLabel = useMemo(() => {
    const o = options.find((x) => x.value === value);
    return o?.label ?? "—";
  }, [options, value]);

  const title =
    sheetTitle ??
    (typeof label === "string" && label ? label : "Seleccionar");

  return (
    <div className="w-full">
      {label ? (
        typeof label === "string" ? (
          <label
            htmlFor={lid}
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            {label}
          </label>
        ) : (
          <div className="mb-1">{label}</div>
        )
      ) : null}
      <select
        id={lid}
        className={`hidden md:block ${selectClassName} ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option
            key={o.value === "" ? "__empty" : String(o.value)}
            value={o.value}
          >
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={disabled}
        className={`md:hidden ${buttonClassName} ${disabled ? "opacity-60" : ""}`}
        onClick={() => {
          if (!disabled) setOpen(true);
        }}
        aria-haspopup="listbox"
      >
        <span className="truncate min-w-0 flex-1 text-left">{currentLabel}</span>
        <span className="text-slate-400 shrink-0" aria-hidden>
          ▼
        </span>
      </button>
      <BottomSheet
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        closeText="Cerrar"
      >
        <div className="px-1 pt-1">
          {options.map((o) => (
            <button
              key={o.value === "" ? "__empty" : String(o.value)}
              type="button"
              className={`w-full text-left px-4 py-3.5 text-sm border-b border-slate-100 last:border-b-0 hover:bg-slate-50 ${
                o.value === value ? "bg-slate-100 font-semibold" : ""
              }`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      </BottomSheet>
    </div>
  );
}
