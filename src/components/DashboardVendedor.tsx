// DashboardVendedor.tsx - Vista para vendedores (solo VentaForm visible)
import React from "react";
import VentaForm from "./SaleForm";
import Sidebar from "./Sidebar";

export default function DashboardVendedor(): React.ReactElement {
  return (
    <div className="flex">
      <Sidebar onNavigate={() => {}} />
      <div className="flex-1 p-4">
        <VentaForm user={null} />
      </div>
    </div>
  );
}
