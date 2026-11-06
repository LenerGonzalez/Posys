import { Box, Card, CardContent, Typography } from "@mui/material";
import { money, percent, qty } from "./format";
import { commissionMethodLabel, type ComputedTotals, type InventorySnapshot } from "./types";

function Kpi({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent>
        <Typography variant="overline" color="text.secondary">
          {label}
        </Typography>
        <Typography variant="h5" sx={{ mt: 0.5 }}>
          {value}
        </Typography>
        {hint ? (
          <Typography variant="caption" color="text.secondary">
            {hint}
          </Typography>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function Dashboard({
  totals,
  history,
}: {
  totals: ComputedTotals;
  history: InventorySnapshot[];
}) {
  const latest = history[history.length - 1];
  const method3 = totals.commissionMethod === "3";
  const poolLabel = method3 ? "Base para comisión" : "Inversionista antes de logística";
  const poolValue = method3 ? totals.commissionBase : totals.investorBeforeLogistics;
  return (
    <Box sx={{ display: "grid", gap: 2 }}>
      <Box
        sx={{
          display: "grid",
          gap: 2,
          gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", lg: "repeat(4, 1fr)" },
        }}
      >
        <Kpi label="Productos" value={qty(totals.productCount)} hint={`${qty(totals.packages)} paquetes`} />
        <Kpi label="Subtotal de compra" value={money(totals.purchaseSubtotal)} />
        <Kpi label="Gastos logísticos" value={money(totals.logisticsCost)} hint={`Costo con logística ${money(totals.costWithLogistics)}`} />
        <Kpi label="Venta proyectada" value={money(totals.projectedSales)} />
        <Kpi label="Utilidad bruta" value={money(totals.grossProfit)} hint="Antes de repartir" />
        <Kpi label="Vendedor" value={money(totals.vendorProfit)} hint={percent(totals.vendorSharePercent, 0)} />
        <Kpi label={poolLabel} value={money(poolValue)} />
        <Kpi label="Utilidad neta" value={money(totals.investorNet)} hint="uNeta del inversionista" />
      </Box>
      <Card>
        <CardContent>
          <Typography variant="h6">Distribución de ganancias</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Método en uso: {commissionMethodLabel(totals.commissionMethod)}
          </Typography>
          <Box
            sx={{
              mt: 2,
              display: "grid",
              gap: 1.5,
              gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" },
            }}
          >
            {[
              ["Ganancia total antes de repartir", money(totals.grossProfit)],
              ["Ganancia del vendedor", money(totals.vendorProfit)],
              [poolLabel, money(poolValue)],
              ["Gastos logísticos", money(totals.logisticsCost)],
              ["Ganancia neta del inversionista", money(totals.investorNet)],
              ["Margen objetivo", percent(totals.targetMarginPercent, 0)],
            ].map(([label, value]) => (
              <Box key={label} sx={{ display: "flex", justifyContent: "space-between", gap: 2, py: 1, borderBottom: "1px solid", borderColor: "divider" }}>
                <Typography variant="body2" color="text.secondary">{label}</Typography>
                <Typography variant="body2" sx={{ fontWeight: 700 }}>{value}</Typography>
              </Box>
            ))}
          </Box>
          {latest ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 2 }}>
              Último guardado: utilidad neta {money(latest.investorNet)}. El resumen en pantalla siempre usa los datos actuales de este inventario.
            </Typography>
          ) : null}
        </CardContent>
      </Card>
    </Box>
  );
}
