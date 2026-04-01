import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { FiChevronDown, FiMenu } from "react-icons/fi";
import BottomSheet from "./BottomSheet";
import SelectOptionList, {
  type SelectListOption,
  selectDropdownPanelClassName,
} from "./SelectOptionList";

export type MobileHtmlSelectOption = SelectListOption;

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
  /**
   * Icono del disparador: chevron (por defecto) o menú/lista (FiMenu, usado en Pollo).
   */
  triggerIcon?: "chevron" | "menu";
};

/** Mismo lenguaje que filtros/tablas junto a ActionMenu (borde gris, sin “pill pro”). */
const desktopTriggerBase =
  "group w-full flex items-center justify-between gap-2 text-left rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 focus-visible:border-gray-300 disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Escritorio (md+): listbox con panel tipo ActionMenu.
 * Móvil: botón + BottomSheet.
 */
export default function MobileHtmlSelect({
  label,
  value,
  onChange,
  options,
  disabled,
  selectClassName = "w-full",
  buttonClassName =
    "w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-left flex items-center justify-between gap-2 bg-white text-gray-900",
  id,
  sheetTitle,
  triggerIcon = "chevron",
}: Props) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [desktopOpen, setDesktopOpen] = useState(false);
  const desktopRef = useRef<HTMLDivElement>(null);
  const autoId = useId();
  const lid = id ?? autoId;

  const currentLabel = useMemo(() => {
    const o = options.find((x) => x.value === value);
    return o?.label ?? "—";
  }, [options, value]);

  const title =
    sheetTitle ??
    (typeof label === "string" && label ? label : "Seleccionar");

  useEffect(() => {
    if (!desktopOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDesktopOpen(false);
    };
    const onDoc = (e: MouseEvent) => {
      if (
        desktopRef.current &&
        !desktopRef.current.contains(e.target as Node)
      ) {
        setDesktopOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDoc);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [desktopOpen]);

  useEffect(() => {
    if (disabled) setDesktopOpen(false);
  }, [disabled]);

  return (
    <div className="w-full">
      {label ? (
        typeof label === "string" ? (
          <label
            htmlFor={lid}
            className="block text-xs font-semibold text-gray-700 mb-1"
          >
            {label}
          </label>
        ) : (
          <div className="mb-1">{label}</div>
        )
      ) : null}

      {/* Escritorio: listbox personalizado */}
      <div
        ref={desktopRef}
        className={`relative hidden md:block ${disabled ? "opacity-60" : ""}`}
      >
        <button
          type="button"
          id={lid}
          disabled={disabled}
          aria-expanded={desktopOpen}
          aria-haspopup="listbox"
          className={`${desktopTriggerBase} ${selectClassName} ${disabled ? "" : "cursor-pointer"} ${desktopOpen ? "ring-2 ring-blue-500/25 border-gray-300" : ""}`}
          onClick={() => {
            if (!disabled) setDesktopOpen((o) => !o);
          }}
        >
          <span className="truncate min-w-0 text-gray-900">{currentLabel}</span>
          {triggerIcon === "menu" ? (
            <FiMenu
              className={`h-4 w-4 shrink-0 text-gray-500 transition-transform duration-200 ${desktopOpen ? "scale-95 opacity-90" : ""}`}
              aria-hidden
            />
          ) : (
            <FiChevronDown
              className={`h-4 w-4 shrink-0 text-gray-400 transition-transform duration-200 ${desktopOpen ? "rotate-180" : ""}`}
              aria-hidden
            />
          )}
        </button>
        {desktopOpen && !disabled && (
          <SelectOptionList
            variant="dropdown"
            options={options}
            value={value}
            ariaLabelledBy={lid}
            className={selectDropdownPanelClassName}
            onSelect={(v) => {
              onChange(v);
              setDesktopOpen(false);
            }}
          />
        )}
      </div>

      {/* Móvil: botón + BottomSheet */}
      <button
        type="button"
        disabled={disabled}
        className={`md:hidden ${buttonClassName} ${disabled ? "opacity-60" : ""}`}
        onClick={() => {
          if (!disabled) setSheetOpen(true);
        }}
        aria-haspopup="listbox"
      >
        <span className="truncate min-w-0 flex-1 text-left">{currentLabel}</span>
        {triggerIcon === "menu" ? (
          <FiMenu className="h-4 w-4 shrink-0 text-gray-500" aria-hidden />
        ) : (
          <FiChevronDown className="h-4 w-4 shrink-0 text-gray-400" aria-hidden />
        )}
      </button>
      <BottomSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={title}
        closeText="Cerrar"
      >
        <SelectOptionList
          variant="sheet"
          options={options}
          value={value}
          onSelect={(v) => {
            onChange(v);
            setSheetOpen(false);
          }}
        />
      </BottomSheet>
    </div>
  );
}
