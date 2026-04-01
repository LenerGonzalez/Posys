import React from "react";
import { FiCheck } from "react-icons/fi";
import Button from "./Button";

/** Opción genérica para listas de selección (dropdown, sheet, etc.). */
export type SelectListOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export function selectOptionKey(value: string): string {
  return value === "" ? "__empty" : String(value);
}

/**
 * Panel flotante (escritorio): mismo contenedor que ActionMenu
 * (CustomersPollo — menú ⋮).
 */
export const selectDropdownPanelClassName =
  "absolute left-0 right-0 z-[100] mt-1 max-h-[min(60vh,320px)] overflow-y-auto overflow-x-hidden overscroll-contain " +
  "bg-white border border-gray-200 rounded-lg shadow-lg py-1";

type SelectOptionListProps = {
  options: SelectListOption[];
  value: string;
  /** Recibe el value elegido (el padre cierra sheet/dropdown si aplica). */
  onSelect: (value: string) => void;
  /** dropdown: lista tipo listbox; sheet: filas para bottom sheet. */
  variant: "dropdown" | "sheet";
  /** className del contenedor (ul o div). */
  className?: string;
  /** aria-labelledby del listbox (variant dropdown). */
  ariaLabelledBy?: string;
};

/** Misma fila que ActionMenu en CustomersPollo: Button ghost + px-3 py-2 text-sm. */
function optionButtonClassName(
  selected: boolean,
  disabled: boolean | undefined,
  isEmptyValue: boolean,
): string {
  const base =
    "w-full !justify-between !rounded-lg px-3 py-2 text-sm !font-normal gap-2 h-auto min-h-0";
  if (disabled) {
    return `${base} !text-gray-400 cursor-not-allowed`;
  }
  const empty =
    isEmptyValue && !selected ? " !text-gray-500 italic !font-normal" : "";
  const sel = selected ? " !bg-gray-50 font-medium" : "";
  return `${base}${empty}${sel}`;
}

export default function SelectOptionList({
  options,
  value,
  onSelect,
  variant,
  className,
  ariaLabelledBy,
}: SelectOptionListProps) {
  if (variant === "dropdown") {
    return (
      <ul
        role="listbox"
        aria-labelledby={ariaLabelledBy}
        className={className}
      >
        {options.map((o) => {
          const selected = o.value === value;
          const isEmpty = o.value === "";
          return (
            <li key={selectOptionKey(o.value)} role="none">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                role="option"
                aria-selected={selected}
                disabled={o.disabled}
                className={optionButtonClassName(selected, o.disabled, isEmpty)}
                onClick={() => {
                  if (o.disabled) return;
                  onSelect(o.value);
                }}
              >
                <span className="min-w-0 flex-1 truncate text-left leading-snug">
                  {o.label}
                </span>
                {selected && !isEmpty ? (
                  <FiCheck
                    className="h-4 w-4 shrink-0 text-gray-500"
                    strokeWidth={2}
                    aria-hidden
                  />
                ) : (
                  <span className="w-4 shrink-0" aria-hidden />
                )}
              </Button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className={className ?? "py-1"}>
      {options.map((o) => {
        const selected = o.value === value;
        const isEmpty = o.value === "";
        return (
          <Button
            key={selectOptionKey(o.value)}
            type="button"
            variant="ghost"
            size="sm"
            disabled={o.disabled}
            className={optionButtonClassName(selected, o.disabled, isEmpty)}
            onClick={() => {
              if (o.disabled) return;
              onSelect(o.value);
            }}
          >
            <span className="min-w-0 flex-1 text-left leading-snug">
              {o.label}
            </span>
            {selected && !isEmpty ? (
              <FiCheck
                className="h-4 w-4 shrink-0 text-gray-500"
                strokeWidth={2}
                aria-hidden
              />
            ) : (
              <span className="w-4 shrink-0" aria-hidden />
            )}
          </Button>
        );
      })}
    </div>
  );
}
