import type { ReactNode } from "react";
import CloseIcon from "@mui/icons-material/Close";
import AccountBalanceWalletOutlinedIcon from "@mui/icons-material/AccountBalanceWalletOutlined";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import PersonOutlineOutlinedIcon from "@mui/icons-material/PersonOutlineOutlined";
import ShoppingCartOutlinedIcon from "@mui/icons-material/ShoppingCartOutlined";
import ShowChartOutlinedIcon from "@mui/icons-material/ShowChartOutlined";
import { Box, Dialog, DialogContent, DialogTitle, IconButton, Typography } from "@mui/material";
import { money, percent, qty } from "./format";
import { availablePackages } from "./saleCommit";
import { productProfitStatus, productStatusLabel } from "./productRanking";
import type { ComputedLine } from "./types";

function ChipFact({ label, value, background, color }: { label: string; value: string; background: string; color: string }) {
  return (
    <Box sx={{ display: "inline-flex", alignItems: "baseline", gap: 0.6, maxWidth: "100%", px: 1.1, py: 0.45, borderRadius: "999px", bgcolor: background }}>
      <Typography sx={{ fontWeight: 700, color, fontSize: { xs: "12px", md: "13px" }, lineHeight: 1.3 }}>{label}</Typography>
      <Typography sx={{ fontWeight: 800, color, fontSize: { xs: "12px", md: "13px" }, lineHeight: 1.3, overflowWrap: "anywhere" }}>{value}</Typography>
    </Box>
  );
}

function Fact({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography color="text.secondary" sx={{ display: "block", mb: 0.35, lineHeight: 1.25, fontSize: { xs: "13px", md: "14px" } }}>{label}</Typography>
      <Typography sx={{ fontWeight: 700, fontSize: { xs: "15px", md: "16px" }, lineHeight: 1.3, color: color || "#1A1C1E", overflowWrap: "anywhere" }}>{value}</Typography>
    </Box>
  );
}

function Section({
  title,
  icon,
  background,
  color,
  children,
}: {
  title: string;
  icon: ReactNode;
  background: string;
  color: string;
  children: ReactNode;
}) {
  return (
    <Box sx={{ minWidth: 0, p: 1.25, borderRadius: "12px", bgcolor: background, boxShadow: "0 1px 2px rgba(26, 28, 30, 0.05)" }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mb: 1.15, color }}>
        {icon}
        <Typography variant="subtitle2" sx={{ color, fontSize: { xs: "16px", md: "17px" }, lineHeight: 1.3 }}>{title}</Typography>
      </Box>
      <Box sx={{ display: "grid", gap: { xs: 1.15, md: 1.35 }, gridTemplateColumns: "1fr 1fr" }}>{children}</Box>
    </Box>
  );
}

export default function PriceDetailDialog({
  open,
  narrow,
  productName,
  inventoryName,
  line,
  initialPackages,
  soldPackages,
  manualCommission,
  onClose,
}: {
  open: boolean;
  narrow: boolean;
  productName: string;
  inventoryName: string;
  line: ComputedLine | null;
  initialPackages: number;
  soldPackages: number;
  manualCommission: number | null;
  onClose: () => void;
}) {
  const status = line ? productProfitStatus(line.investorNet, line.realMarginPercent) : null;
  const statusColor = status === "rentable" ? "#0D652D" : status === "perdida" || status === "margen_negativo" ? "#A50E0E" : "#8D4E00";
  const statusBackground = status === "rentable" ? "#E6F4EA" : status === "perdida" || status === "margen_negativo" ? "#FCE8E6" : "#FEF4D6";
  const invoice = line?.orderCode.trim() ? line.orderCode.trim() : "Sin factura";

  return (
    <Dialog
      open={open && !!line}
      onClose={onClose}
      fullScreen={narrow}
      fullWidth
      maxWidth="md"
      slotProps={{
        paper: {
          sx: {
            display: "flex",
            flexDirection: "column",
            borderRadius: narrow ? 0 : "20px",
            height: narrow ? "100%" : "auto",
            maxHeight: narrow ? "100%" : "min(760px, calc(100% - 64px))",
          },
        },
      }}
    >
      {line && status ? (
        <>
          <DialogTitle
            sx={{
              display: "flex",
              alignItems: "flex-start",
              gap: 1,
              pr: 6,
              pt: narrow ? "calc(12px + env(safe-area-inset-top))" : 2,
              pb: 1,
            }}
          >
            <Box sx={{ width: 36, height: 36, borderRadius: "10px", bgcolor: "#E8F0FE", color: "#1A56DB", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Inventory2OutlinedIcon fontSize="small" />
            </Box>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography sx={{ fontWeight: 800, fontSize: { xs: "19px", md: "20px" }, lineHeight: 1.25, overflowWrap: "anywhere" }}>{productName}</Typography>
              <Typography color="text.secondary" sx={{ display: "block", fontSize: { xs: "13px", md: "14px" }, lineHeight: 1.3, overflowWrap: "anywhere" }}>{inventoryName}</Typography>
              <Box sx={{ display: "inline-flex", alignItems: "center", mt: 0.6, px: 1.1, py: 0.35, borderRadius: "999px", bgcolor: statusBackground }}>
                <Typography sx={{ fontWeight: 700, color: statusColor, fontSize: { xs: "12px", md: "13px" }, lineHeight: 1.3 }}>{productStatusLabel(status)}</Typography>
              </Box>
            </Box>
            <IconButton aria-label="Cerrar" onClick={onClose} sx={{ position: "absolute", right: 8, top: narrow ? "calc(8px + env(safe-area-inset-top))" : 8 }}>
              <CloseIcon />
            </IconButton>
          </DialogTitle>
          <DialogContent sx={{ display: "grid", alignContent: "start", gap: 1.25, flex: "1 1 auto !important", minHeight: 0, overflow: "auto", pb: "calc(16px + env(safe-area-inset-bottom))" }}>
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.6 }}>
              <ChipFact label="Precio de costo" value={money(line.costPlusLogisticsPerPack)} background="#FEF4D6" color="#8D4E00" />
              <ChipFact label="Precio de venta" value={money(line.appliedPrice)} background="#E6F4EA" color="#0D652D" />
              <ChipFact label="Costo por paquete" value={money(line.costPerPack)} background="#E8F0FE" color="#1A56DB" />
              <ChipFact label="Logística por paquete" value={money(line.logisticsPerPack)} background="#FFF7F0" color="#C05A12" />
              <ChipFact label="Paquetes iniciales" value={qty(initialPackages)} background="#E7EDF4" color="#3A4654" />
              <ChipFact label="Vendidos" value={qty(soldPackages)} background="#F7F4FC" color="#6D4BA1" />
              <ChipFact label="Disponibles" value={qty(availablePackages(initialPackages, soldPackages))} background="#E6F4EA" color="#0D652D" />
            </Box>
            <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}>
              <Section title="Compra y precios" icon={<ShoppingCartOutlinedIcon fontSize="small" />} background="#F3F7FE" color="#1A56DB">
                <Fact label="Orden o factura" value={invoice} />
                <Fact label="Producto" value={line.name || productName} />
                <Fact label="Costo por paquete" value={money(line.costPerPack)} />
                <Fact label="Cantidad de paquetes" value={qty(line.packages)} />
                <Fact label="Subtotal" value={money(line.purchaseSubtotal)} />
                <Fact label="Venta total" value={money(line.salesTotal)} color="#1A56DB" />
                {line.manualPrice > 0 ? <Fact label="Precio manual" value={money(line.manualPrice)} /> : null}
                <Fact label="Precio de venta aplicado" value={money(line.appliedPrice)} color="#1A56DB" />
              </Section>
              <Section title="Rentabilidad" icon={<ShowChartOutlinedIcon fontSize="small" />} background="#F2FAF5" color="#0D652D">
                <Fact label="Utilidad bruta" value={money(line.grossProfit)} color="#0D652D" />
                <Fact label="Utilidad bruta por paquete" value={money(line.grossProfitPerPack)} />
                <Fact label="Margen real" value={percent(line.realMarginPercent)} color="#0D652D" />
                <Fact label="Margen bruto del sistema" value={percent(line.systemGrossMarginPercent)} />
                <Fact label="Logística total" value={money(line.logisticsAllocated)} />
                <Fact label="Logística por paquete" value={money(line.logisticsPerPack)} />
              </Section>
              <Section title="Ganancias del vendedor" icon={<PersonOutlineOutlinedIcon fontSize="small" />} background="#F7F4FC" color="#6D4BA1">
                {manualCommission != null ? <Fact label="Comisión manual" value={percent(manualCommission, 0)} /> : null}
                <Fact label="Comisión aplicada" value={percent(line.vendorSharePercent, 0)} />
                <Fact label="Ganancia total del vendedor" value={money(line.vendorProfit)} color="#6D4BA1" />
                <Fact label="Ganancia del vendedor por paquete" value={money(line.vendorProfitPerPack)} />
              </Section>
              <Section title="Ganancias del inversionista" icon={<AccountBalanceWalletOutlinedIcon fontSize="small" />} background="#FFF7F0" color="#C05A12">
                <Fact label="Ganancia antes de logística" value={money(line.investorBeforeLogistics)} />
                <Fact label="Ganancia antes de logística por paquete" value={money(line.investorBeforeLogisticsPerPack)} />
                <Fact label="Ganancia neta total" value={money(line.investorNet)} color="#C05A12" />
                <Fact label="Ganancia neta por paquete" value={money(line.investorNetPerPack)} />
              </Section>
            </Box>
          </DialogContent>
        </>
      ) : null}
    </Dialog>
  );
}
