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

    const onDown = (ev: MouseEvent) => {
      const target = ev.target as Node;
      if (ref.current && !ref.current.contains(target)) onClose();
    };

    const onScroll = (ev: Event) => {
      const target = ev.target as Node;
      if (ref.current && !ref.current.contains(target)) onClose();
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };

    // Attach listeners on next tick so the opening click doesn't immediately
    // trigger the outside handler (menu needs to be mounted first).
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", onDown);
      document.addEventListener("scroll", onScroll, true);
      document.addEventListener("keydown", onKey);
    }, 0);

    // debug log: menu mounted
    // eslint-disable-next-line no-console
    console.log("ActionMenu mount", { isOpen, anchorRect });

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [isOpen, onClose]);

  if (!isOpen || !anchorRect) return null;

  const left = Math.min(
    Math.max(anchorRect.left, 8),
    window.innerWidth - width - 8,
  );
  const top = anchorRect.bottom + 8;

  const el = (
    <div
      ref={ref}
      style={{
        position: "fixed",
        top: `${top}px`,
        left: `${left}px`,
        width,
        zIndex: 9999,
      }}
      className="bg-white border rounded shadow-lg overflow-visible"
    >
      {children}
    </div>
  );

  return createPortal(el, document.body);
}
