import React from "react";

export default function LoadingOverlay({ message = "Cargando..." }) {
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 rounded-2xl bg-slate-900/90 px-6 py-5 text-white shadow-2xl">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/40 border-t-white" />
        <div className="text-sm font-semibold tracking-wide">{message}</div>
      </div>
    </div>
  );
}
