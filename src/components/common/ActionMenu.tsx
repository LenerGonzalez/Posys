import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

type Props = {
  anchorRect: DOMRect | null;
  isOpen: boolean;
  onClose: () => void;
  width?: number;
  children?: React.ReactNode;
};

export default function ActionMenu({
  anchorRect,
  isOpen,
  onClose,
  width = 168,
  children,
}: Props): React.ReactElement | null {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    const onPointerDown = (ev: PointerEvent) => {
      const target = ev.target as Node;
      if (ref.current && !ref.current.contains(target)) onClose();
    };

    const onScroll = (ev: Event) => {
      const target = ev.target as Node;
      if (ref.current && ref.current.contains(target)) return;
      // Solo cerrar con scroll del documento/ventana; no con scroll dentro de modales o paneles
      // (si no, el overflow-y del modal dispara el cierre y el menú “no aparece”).
      const t = ev.target as HTMLElement | null;
      if (
        t === document ||
        t === document.documentElement ||
        t === document.body
      ) {
        onClose();
      }
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };

    // Retraso breve: en táctil el mismo gesto que abre el menú puede disparar
    // pointerdown en documento y cerrarlo al instante; pointerdown cubre mouse + touch.
    const timer = setTimeout(() => {
      document.addEventListener("pointerdown", onPointerDown);
      document.addEventListener("scroll", onScroll, true);
      document.addEventListener("keydown", onKey);
    }, 100);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [isOpen, onClose]);

  if (!isOpen || !anchorRect) return null;

  const vw = typeof window !== "undefined" ? window.innerWidth : 400;
  const vh = typeof window !== "undefined" ? window.innerHeight : 600;

  const left = Math.min(Math.max(anchorRect.left, 8), vw - width - 8);

  /** Altura máxima con scroll para que no se corten opciones abajo del viewport (móvil). */
  const maxMenuHeight = Math.min(320, Math.max(120, vh - 16));
  const gap = 8;
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

  const el = (
    <div
      data-action-menu-root
      ref={ref}
      style={{
        position: "fixed",
        top: `${top}px`,
        left: `${left}px`,
        width,
        maxHeight: maxMenuHeight,
        zIndex: 9999,
      }}
      className="bg-white border rounded shadow-lg overflow-y-auto overflow-x-hidden overscroll-contain py-1"
    >
      {children}
    </div>
  );

  return createPortal(el, document.body);
}
