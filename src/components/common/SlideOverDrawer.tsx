import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { FiX } from "react-icons/fi";

export type SlideOverDrawerProps = {
  open: boolean;
  onClose: () => void;
  /** Título principal (cabecera) */
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Contenido opcional bajo el subtítulo (p. ej. badge de estado) */
  badge?: React.ReactNode;
  /** id del título para aria-labelledby */
  titleId?: string;
  children: React.ReactNode;
  /** Barra inferior fija (acciones) */
  footer?: React.ReactNode;
  zIndexClassName?: string;
  /** Ancho máximo del panel (Tailwind), por defecto un poco más ancho que `max-w-xl` */
  panelMaxWidthClassName?: string;
  backdropClassName?: string;
  container?: Element | DocumentFragment | null;
  backdropAriaLabel?: string;
};

/**
 * Panel lateral (slide-over) desde la derecha, con backdrop, cierre por clic fuera
 * y tecla Escape. Misma UX que el detalle de pedidos en inventario de pollo (md+).
 */
export default function SlideOverDrawer({
  open,
  onClose,
  title,
  subtitle,
  badge,
  titleId,
  children,
  footer,
  zIndexClassName = "z-[76]",
  panelMaxWidthClassName = "max-w-2xl",
  backdropClassName = "bg-black/40",
  container,
  backdropAriaLabel = "Cerrar panel",
}: SlideOverDrawerProps) {
  const target =
    container ?? (typeof document !== "undefined" ? document.body : null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !target) return null;

  return createPortal(
    <div
      className={`fixed inset-0 ${zIndexClassName} flex justify-end`}
    >
      <button
        type="button"
        className={`absolute inset-0 ${backdropClassName} border-0 cursor-default`}
        aria-label={backdropAriaLabel}
        onClick={onClose}
      />
      <aside
        className={`relative flex h-full w-full ${panelMaxWidthClassName} flex-col bg-white shadow-2xl`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-gray-200 px-4 py-2">
          <div className="min-w-0 pr-1">
            <h2
              id={titleId}
              className="text-base font-bold text-gray-900 leading-snug truncate"
            >
              {title}
            </h2>
            {(subtitle != null && subtitle !== "") || badge != null ? (
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                {subtitle != null && subtitle !== "" && (
                  <span className="text-sm text-gray-600">{subtitle}</span>
                )}
                {badge != null ? (
                  <span className="inline-flex shrink-0 items-center">
                    {badge}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="shrink-0 rounded-lg p-1.5 text-gray-600 hover:bg-gray-100"
            onClick={onClose}
            aria-label="Cerrar"
          >
            <FiX className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2.5">{children}</div>

        {footer != null && (
          <div className="shrink-0 border-t border-gray-200 bg-gray-50 px-4 py-2.5 flex flex-wrap gap-2">
            {footer}
          </div>
        )}
      </aside>
    </div>,
    target,
  );
}
