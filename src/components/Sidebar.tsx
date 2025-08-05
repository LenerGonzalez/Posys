
import React from "react";

const Sidebar = ({ onNavigate }: { onNavigate: (section: string) => void }) => {
  const sections = [
    { name: "Ventas", key: "ventas" },
    { name: "Inventario", key: "inventario" },
    { name: "Cierre", key: "cierre" },
    { name: "PDF", key: "pdf" },
  ];

  return (
    <div className="w-full sm:w-48 bg-gray-100 p-4 space-y-2">
      <h2 className="font-bold mb-4">Menú</h2>
      {sections.map((s) => (
        <button
          key={s.key}
          onClick={() => onNavigate(s.key)}
          className="block w-full text-left px-3 py-2 rounded hover:bg-gray-200"
        >
          {s.name}
        </button>
      ))}
    </div>
  );
};

export default Sidebar;
