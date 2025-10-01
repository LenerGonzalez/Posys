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
      className={`flex items-center gap-2 px-3 py-1.5 rounded-2xl  border 
        bg-white hover:bg-gray-100 text-sm font-medium shadow-2xl
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
