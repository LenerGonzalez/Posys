// DashboardAdmin.tsx - Vista exclusiva para administradores
import React from "react";
import VentaForm from "../../components/Pollo/SaleForm";
import InventarioForm from "../../components/Pollo/InventarioForm";
import CierreVentas from "../../components/Pollo/CierreVentas";
import PDFGenerator from "./PDFGenerator";
import Sidebar from "../../components/Pollo/Sidebar";
import ProductForm from "../../components/Pollo/ProductForm";
import SaleForm from "../../components/Pollo/SaleForm";
import { Role } from "../../apis/apis";
import HistorialCierres from "../../components/Pollo/HistorialCierres";
import UserRegisterForm from "../UserRegisterForm";

export default function DashboardAdmin(): React.JSX.Element {
  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar
        onNavigate={(section: string) => {
          /* handle navigation here */
        }}
      />
      <div className="flex-1 p-8 space-y-8">
        <UserRegisterForm />
        <SaleForm user={""} />
        <CierreVentas role={Role.ADMIN} />
        <HistorialCierres />
        <ProductForm />
        <InventarioForm />
      </div>
    </div>
  );
}
