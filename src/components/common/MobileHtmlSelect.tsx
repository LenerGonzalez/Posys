import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiChevronDown, FiMenu } from "react-icons/fi";
import BottomSheet from "./BottomSheet";
import SelectOptionList, {
  type SelectListOption,
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

function computeDropdownPosition(anchorRect: DOMRect) {
  const vw = typeof window !== "undefined" ? window.innerWidth : 400;
  const vh = typeof window !== "undefined" ? window.innerHeight : 600;
  const width = Math.min(anchorRect.width, vw - 16);
  const left = Math.min(Math.max(anchorRect.left, 8), vw - width - 8);
  const maxMenuHeight = Math.min(320, Math.max(120, vh - 16));
  const gap = 4;
  let top = anchorRect.bottom + gap;
  const spaceBelow = vh - anchorRect.bottom - gap;
  const spaceAbove = anchorRect.top - gap;
  if (top + maxMenuHeight > vh - 8) {
    const openAbove = anchorRect.top - maxMenuHeight - gap;
    if (openAbove >= 8 && spaceAbove >= spaceBelow) {
      top = openAbove;
    } else {
      top = Math.max(8, vh - maxMenuHeight - 8);
    }
  }
  return { top, left, width, maxMenuHeight };
}

/**
 * Escritorio (md+): listbox con panel portaled (scroll, no se recorta en modales).
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
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
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
    if (!desktopOpen) {
      setAnchorRect(null);
      return;
    }

    const syncRect = () => {
      if (triggerRef.current) {
        setAnchorRect(triggerRef.current.getBoundingClientRect());
      }
    };

    syncRect();
    window.addEventListener("resize", syncRect);
    window.addEventListener("scroll", syncRect, true);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDesktopOpen(false);
    };

    const onPointerDown = (ev: PointerEvent) => {
      const target = ev.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setDesktopOpen(false);
    };

    const onScroll = (ev: Event) => {
      const target = ev.target as Node;
      if (dropdownRef.current?.contains(target)) return;
      const t = ev.target as HTMLElement | null;
      if (
        t === document ||
        t === document.documentElement ||
        t === document.body
      ) {
        setDesktopOpen(false);
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener("keydown", onKey);
      document.addEventListener("pointerdown", onPointerDown);
      document.addEventListener("scroll", onScroll, true);
    }, 100);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", syncRect);
      window.removeEventListener("scroll", syncRect, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [desktopOpen]);

  useEffect(() => {
    if (disabled) setDesktopOpen(false);
  }, [disabled]);

  const dropdownPos = anchorRect ? computeDropdownPosition(anchorRect) : null;

  const desktopDropdown =
    desktopOpen && !disabled && dropdownPos && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={dropdownRef}
            data-mobile-html-select-dropdown
            style={{
              position: "fixed",
              top: `${dropdownPos.top}px`,
              left: `${dropdownPos.left}px`,
              width: `${dropdownPos.width}px`,
              maxHeight: `${dropdownPos.maxMenuHeight}px`,
              zIndex: 10000,
            }}
            className="overflow-y-auto overflow-x-hidden overscroll-contain bg-white border border-gray-200 rounded-lg shadow-lg py-1"
          >
            <SelectOptionList
              variant="dropdown"
              options={options}
              value={value}
              ariaLabelledBy={lid}
              className="max-h-none overflow-visible shadow-none border-0 rounded-none py-0"
              onSelect={(v) => {
                onChange(v);
                setDesktopOpen(false);
              }}
            />
          </div>,
          document.body,
        )
      : null;

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

      {/* Escritorio: listbox personalizado (portal) */}
      <div className={`hidden md:block ${disabled ? "opacity-60" : ""}`}>
        <button
          ref={triggerRef}
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
        {desktopDropdown}
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
        zIndexClassName="z-[200]"
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
