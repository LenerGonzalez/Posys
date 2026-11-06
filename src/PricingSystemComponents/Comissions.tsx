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
    <Box sx={{ display: "grid", gap: 2 }}>
      <Typography variant="body2" color="text.secondary">
        Método en uso: {commissionMethodLabel(totals.commissionMethod)}
      </Typography>
      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr 1fr" } }}>
        <Card>
          <CardContent>
            <Typography variant="overline" color="text.secondary">Vendedor</Typography>
            <Typography variant="h5">{money(totals.vendorProfit)}</Typography>
            <Typography variant="body2" color="text.secondary">Comisión general {percent(totals.vendorSharePercent, 0)}</Typography>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Typography variant="overline" color="text.secondary">{poolLabel}</Typography>
            <Typography variant="h5">{money(poolValue)}</Typography>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Typography variant="overline" color="text.secondary">Inversionista neto</Typography>
            <Typography variant="h5" color={totals.investorNet < 0 ? "error" : "success.main"}>
              {money(totals.investorNet)}
            </Typography>
          </CardContent>
        </Card>
      </Box>
      <Box sx={{ display: { xs: "grid", md: "none" }, gap: 1.5 }}>
        {lines.map((line) => {
          const product = byId.get(line.id);
          return (
            <Card key={line.id} variant="outlined">
              <CardContent>
                <Typography variant="subtitle2">{line.name}</Typography>
                <Typography variant="body2" color="text.secondary">{qty(line.packages)} paquetes</Typography>
                <NumericField
                  sx={{ mt: 1 }}
                  label="Comisión del producto"
                  kind="optionalCommission"
                  placeholder={`${totals.vendorSharePercent}`}
                  value={product?.vendorSharePercent ?? null}
                  adornment="%"
                  onCommit={(value) => onChangeProduct(line.id, { vendorSharePercent: value })}
                />
                <Typography variant="body2" sx={{ mt: 1 }}>
                  {method3 ? "Base" : "Base de comisión"} {money(line.commissionBase)}
                </Typography>
                <Typography variant="body2" sx={{ mt: 0.5 }}>Vendedor {money(line.vendorProfit)}</Typography>
                <Typography variant="body2" color={line.alerts.investorBelowVendor ? "error" : "text.primary"}>
                  Inversionista neto {money(line.investorNet)}
                </Typography>
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
