import React from "react";

type Entry = {
  label: string;
  value: React.ReactNode;
};

interface KpiCardProps {
  title: string;
  entries: Entry[];
  bgClass?: string;
  collapsed?: boolean;
  collapsible?: boolean;
  onToggle?: (next: boolean) => void;
}

export default function KpiCard({
  title,
  entries,
  bgClass = "bg-white",
  collapsed = false,
  collapsible = true,
  onToggle,
}: KpiCardProps) {
  return (
    <div className={`border rounded-2xl p-3 ${bgClass}`}>
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">{title}</div>
        {collapsible && (
          <button
            type="button"
            className="text-xs text-gray-500"
            onClick={() => onToggle && onToggle(!collapsed)}
            aria-label={collapsed ? `Ver ${title}` : `Ocultar ${title}`}
          >
            {collapsed ? "Ver" : "Ocultar"}
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="mt-3 space-y-2">
          {entries.map((e, i) => (
            <div key={i}>
              <div className="text-xs text-gray-600">{e.label}</div>
              <div className="text-xl font-bold break-words max-w-full">
                {e.value}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
