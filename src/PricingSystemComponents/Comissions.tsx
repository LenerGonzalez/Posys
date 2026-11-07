import {
  Box,
  Card,
  CardContent,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { money, percent, qty } from "./format";
import { metricCellSx, metricGridSx } from "./screen";
import NumericField from "./NumericField";
import { commissionMethodLabel, type ComputedLine, type ComputedTotals, type ProductInput } from "./types";

export default function Comissions({
  lines,
  totals,
  products,
  onChangeProduct,
}: {
  lines: ComputedLine[];
  totals: ComputedTotals;
  products: ProductInput[];
  onChangeProduct: (id: string, patch: Partial<ProductInput>) => void;
}) {
  const byId = new Map(products.map((product) => [product.id, product]));
  const method3 = totals.commissionMethod === "3";
  const poolLabel = method3 ? "Base para comisión" : "Inversionista antes de logística";
  const poolValue = method3 ? totals.commissionBase : totals.investorBeforeLogistics;
  return (
    <Box sx={{ display: "grid", gap: { xs: 1.25, md: 2 } }}>
      <Typography variant="body2" color="text.secondary">
        Método en uso: {commissionMethodLabel(totals.commissionMethod)}
      </Typography>
      <Box sx={{ ...metricGridSx, gridTemplateColumns: { xs: "1fr 1fr", md: "1fr 1fr 1fr" } }}>
        <Box sx={metricCellSx}>
          <Typography variant="caption" color="text.secondary">Vendedor</Typography>
          <Typography sx={{ fontWeight: 800, fontSize: { xs: "0.95rem", md: "1.25rem" } }}>{money(totals.vendorProfit)}</Typography>
          <Typography variant="caption" color="text.secondary">Comisión general {percent(totals.vendorSharePercent, 0)}</Typography>
        </Box>
        <Box sx={metricCellSx}>
          <Typography variant="caption" color="text.secondary">{poolLabel}</Typography>
          <Typography sx={{ fontWeight: 800, fontSize: { xs: "0.95rem", md: "1.25rem" } }}>{money(poolValue)}</Typography>
        </Box>
        <Box sx={{ ...metricCellSx, gridColumn: { xs: "1 / -1", md: "auto" } }}>
          <Typography variant="caption" color="text.secondary">Inversionista neto</Typography>
          <Typography sx={{ fontWeight: 800, fontSize: { xs: "0.95rem", md: "1.25rem" }, color: totals.investorNet < 0 ? "error.main" : "success.main" }}>
            {money(totals.investorNet)}
          </Typography>
        </Box>
      </Box>
      <Box sx={{ display: { xs: "grid", md: "none" }, gap: 0.75 }}>
        {lines.map((line) => {
          const product = byId.get(line.id);
          return (
            <Card key={line.id} variant="outlined">
              <CardContent sx={{ display: "grid", gap: 0.75 }}>
                <Box>
                  <Typography variant="subtitle2" sx={{ fontSize: "0.95rem" }}>{line.name}</Typography>
                  <Typography variant="caption" color="text.secondary">{qty(line.packages)} paquetes</Typography>
                </Box>
                <NumericField
                  label="Comisión del producto"
                  kind="optionalCommission"
                  placeholder={`${totals.vendorSharePercent}`}
                  value={product?.vendorSharePercent ?? null}
                  adornment="%"
                  onCommit={(value) => onChangeProduct(line.id, { vendorSharePercent: value })}
                />
                <Box sx={{ display: "grid", gap: 0.25 }}>
                  <Typography variant="caption">{method3 ? "Base" : "Base de comisión"} {money(line.commissionBase)}</Typography>
                  <Typography variant="caption">Vendedor {money(line.vendorProfit)}</Typography>
                  <Typography variant="caption" color={line.alerts.investorBelowVendor ? "error" : "text.primary"}>
                    Inversionista neto {money(line.investorNet)}
                  </Typography>
                </Box>
              </CardContent>
            </Card>
          );
        })}
      </Box>
      <Card sx={{ display: { xs: "none", md: "block" }, overflow: "auto" }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              {["Producto", "Paquetes", "Comisión", "Base / paq.", "Base", "Vendedor / paq.", "Vendedor total", "Inversionista neto / paq.", "Inversionista neto"].map((label) => (
                <TableCell key={label}>{label}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {lines.map((line) => {
              const product = byId.get(line.id);
              return (
                <TableRow key={line.id} hover>
                  <TableCell>{line.name}</TableCell>
                  <TableCell>{qty(line.packages)}</TableCell>
                  <TableCell sx={{ minWidth: 120 }}>
                    <NumericField
                      kind="optionalCommission"
                      placeholder={String(totals.vendorSharePercent)}
                      value={product?.vendorSharePercent ?? null}
                      adornment="%"
                      onCommit={(value) => onChangeProduct(line.id, { vendorSharePercent: value })}
                    />
                  </TableCell>
                  <TableCell sx={{ whiteSpace: "nowrap" }}>{money(line.commissionBasePerPack)}</TableCell>
                  <TableCell sx={{ whiteSpace: "nowrap" }}>{money(line.commissionBase)}</TableCell>
                  <TableCell sx={{ whiteSpace: "nowrap" }}>{money(line.vendorProfitPerPack)}</TableCell>
                  <TableCell>{money(line.vendorProfit)}</TableCell>
                  <TableCell sx={{ color: line.alerts.investorBelowVendor ? "error.main" : "inherit" }}>
                    {money(line.investorNetPerPack)}
                  </TableCell>
                  <TableCell sx={{ color: line.alerts.investorBelowVendor ? "error.main" : "inherit", fontWeight: 700 }}>
                    {money(line.investorNet)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
    </Box>
  );
}
