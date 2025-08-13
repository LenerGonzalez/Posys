// DashboardAdmin.tsx - Vista exclusiva para administradores
import React from "react";
import VentaForm from "./SaleForm";
import InventarioForm from "./InventarioForm";
import CierreVentas from "./CierreVentas";
import PDFGenerator from "./PDFGenerator";
import Sidebar from "./Sidebar";
import ProductForm from "./ProductForm";
import SaleForm from "./SaleForm";
import { Role } from "../apis/apis";
import HistorialCierres from "./HistorialCierres";
import UserRegisterForm from "./UserRegisterForm";

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
