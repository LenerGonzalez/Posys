import React from "react";
import { FiRefreshCw } from "react-icons/fi"; // librería react-icons (asegurate tenerla instalada)

interface RefreshButtonProps {
  onClick: () => void;
  loading?: boolean;
  className?: string;
}

export default function RefreshButton({
  onClick,
  loading,
  className = "",
}: RefreshButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={`flex items-center gap-2 px-3 py-2 rounded-md border border-slate-200 
        bg-white hover:bg-slate-50 text-xs font-semibold shadow-sm
        disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      title="Refrescar datos"
    >
      <FiRefreshCw
        className={`w-4 h-4 ${loading ? "animate-spin text-blue-500" : ""}`}
      />
      {loading ? "Actualizando..." : "Refrescar"}
    </button>
  );
}
