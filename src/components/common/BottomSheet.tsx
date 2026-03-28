import React from "react";
import { createPortal } from "react-dom";

export type BottomSheetProps = {
  open: boolean;
  onClose: () => void;
  /** Título en la cabecera del panel */
  title: React.ReactNode;
  /** Contenido con scroll (lista de opciones, etc.) */
  children: React.ReactNode;
  /** Texto del botón de cierre (cabecera) */
  closeText?: string;
  /** aria-label del diálogo; por defecto se usa el título si es string */
  ariaLabel?: string;
  /** Opacidad del backdrop (clase Tailwind), ej. bg-black/45 */
  backdropClassName?: string;
  /** z-index del overlay completo */
  zIndexClassName?: string;
  /** Clases extra del panel blanco */
  panelClassName?: string;
  /**
   * En md+ el panel se comporta como modal centrado (redondeado en todos los lados).
   * En móvil queda anclado abajo con solo esquinas superiores redondeadas.
   */
  centerOnDesktop?: boolean;
  /** Nodo donde montar el portal (por defecto document.body) */
  container?: Element | DocumentFragment | null;
};

/**
 * Panel tipo bottom sheet en móvil y modal centrado en pantallas medianas/grandes,
 * con backdrop y portal a body (misma UX que ventas dulces / SaleFormV2).
 */
export default function BottomSheet({
  open,
  onClose,
  title,
  children,
  closeText = "Cerrar",
  ariaLabel,
  backdropClassName = "bg-black/45",
  zIndexClassName = "z-[200]",
  panelClassName = "",
  centerOnDesktop = true,
  container,
}: BottomSheetProps) {
  const target = container ?? (typeof document !== "undefined" ? document.body : null);

  if (!open || !target) return null;

  const dialogAria =
    ariaLabel ??
    (typeof title === "string" ? title : "Panel");

  const panelRounded = centerOnDesktop
    ? "rounded-t-2xl md:rounded-2xl shadow-2xl w-full max-h-[min(78vh,520px)] flex flex-col mx-auto md:max-w-lg md:my-auto"
    : "rounded-t-2xl shadow-2xl w-full max-h-[min(78vh,520px)] flex flex-col mx-auto max-w-lg";

  return createPortal(
    <div
      className={`fixed inset-0 ${zIndexClassName} flex flex-col justify-end md:justify-center`}
      role="dialog"
      aria-modal="true"
      aria-label={dialogAria}
    >
      <button
        type="button"
        className={`absolute inset-0 ${backdropClassName} border-0 cursor-default`}
        aria-label="Cerrar"
        onClick={onClose}
      />
      <div
        className={`relative z-10 bg-white ${panelRounded} ${panelClassName}`.trim()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-slate-200 shrink-0">
          <span className="font-semibold text-slate-800">{title}</span>
          <button
            type="button"
            className="text-sm text-blue-600 font-medium px-2 py-1"
            onClick={onClose}
          >
            {closeText}
          </button>
        </div>
        <div className="overflow-y-auto overscroll-contain px-2 pb-4 flex-1 min-h-0">
          {children}
        </div>
      </div>
    </div>,
    target,
  );
}
