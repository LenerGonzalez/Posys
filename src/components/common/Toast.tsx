import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export type ToastType = "success" | "error" | "warning" | "info";

interface ToastProps {
  message: string;
  type?: ToastType;
  duration?: number;
  onClose: () => void;
}

const ICONS: Record<ToastType, string> = {
  success: "✅",
  error: "❌",
  warning: "⚠️",
  info: "ℹ️",
};

const BG: Record<ToastType, string> = {
  success: "bg-green-50 border-green-300 text-green-800",
  error: "bg-red-50 border-red-300 text-red-800",
  warning: "bg-amber-50 border-amber-300 text-amber-800",
  info: "bg-blue-50 border-blue-300 text-blue-800",
};

function detectType(msg: string): ToastType {
  if (msg.startsWith("✅")) return "success";
  if (msg.startsWith("❌")) return "error";
  if (msg.startsWith("⚠")) return "warning";
  if (msg.startsWith("↩")) return "info";
  if (msg.startsWith("🗑")) return "info";
  return "info";
}

function stripEmoji(msg: string): string {
  return msg.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{2700}-\u{27BF}✅❌⚠️↩️🗑️ℹ️]+\s*/u, "").trim();
}

export default function Toast({
  message,
  type,
  duration = 4000,
  onClose,
}: ToastProps): React.ReactElement | null {
  const [visible, setVisible] = useState(true);
  const [exiting, setExiting] = useState(false);

  const resolved = type ?? detectType(message);
  const cleanMsg = stripEmoji(message);

  useEffect(() => {
    setVisible(true);
    setExiting(false);
    const timer = setTimeout(() => {
      setExiting(true);
      setTimeout(onClose, 300);
    }, duration);
    return () => clearTimeout(timer);
  }, [message, duration, onClose]);

  if (!visible || !message) return null;

  return createPortal(
    <div
      className={`fixed top-4 left-1/2 -translate-x-1/2 z-[9999] max-w-[92vw] w-auto
        flex items-start gap-2.5 px-4 py-3 rounded-xl border shadow-lg
        transition-all duration-300
        ${exiting ? "opacity-0 -translate-y-2" : "opacity-100 translate-y-0"}
        ${BG[resolved]}`}
      role="alert"
    >
      <span className="text-lg leading-none shrink-0">{ICONS[resolved]}</span>
      <span className="text-sm font-medium leading-snug">{cleanMsg}</span>
      <button
        onClick={() => {
          setExiting(true);
          setTimeout(onClose, 300);
        }}
        className="ml-2 shrink-0 opacity-60 hover:opacity-100 text-current"
        aria-label="Cerrar"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      </button>
    </div>,
    document.body,
  );
}
