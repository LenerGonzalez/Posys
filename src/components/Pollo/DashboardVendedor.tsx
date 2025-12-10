// DashboardVendedor.tsx - Vista para vendedores (solo VentaForm visible)
import React from "react";
import VentaForm from "../../components/Pollo/SaleForm";
import Sidebar from "../../components/Pollo/Sidebar";
import SaleForm from "../../components/Pollo/SaleForm";
import CierreVentas from "../../components/Pollo/CierreVentas";
import { Role } from "../../apis/apis";

export default function DashboardVendedor(): React.ReactElement {
  return (
    <div className="flex">
      <Sidebar onNavigate={() => {}} />
      <div className="flex-1 p-4">
        <SaleForm user={""} />
        <CierreVentas role={Role.VENDEDOR} />
      </div>
    </div>
  );
}
