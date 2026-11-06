import { useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { money, percent, qty } from "./format";
import { invoiceOptions, scopeInventories, uniqueInventories } from "./profitability";
import {
  buildProductRanking,
  EMPTY_PRODUCT_RANK_FILTERS,
  productStatusLabel,
  type ProductProfitStatus,
  type ProductRankFilters,
  type ProductRankSort,
} from "./productRanking";
import type { PricingInventory } from "./types";

const STATUS_STYLE: Record<ProductProfitStatus, { bg: string; color: string }> = {
  rentable: { bg: "#E6F4EA", color: "#0D652D" },
  margen_bajo: { bg: "#FEF4D6", color: "#6B3E00" },
  perdida: { bg: "#FCE8E6", color: "#C5221F" },
  sin_rentabilidad: { bg: "#F1F3F4", color: "#5F6368" },
  margen_negativo: { bg: "#F3E8FD", color: "#681DA8" },
};

function inventoryLabel(item: PricingInventory, items: PricingInventory[]): string {
  const duplicated = items.filter((other) => other.name.trim() === item.name.trim()).length > 1;
  return duplicated ? `${item.name} · ${item.id.slice(0, 6)}` : item.name;
}

export default function ProductProfitability({
  inventories,
  onBack,
}: {
  inventories: PricingInventory[];
  onBack: () => void;
}) {
  const [filters, setFilters] = useState<ProductRankFilters>(EMPTY_PRODUCT_RANK_FILTERS);
  const unique = useMemo(() => uniqueInventories(inventories), [inventories]);
  const invoices = useMemo(() => invoiceOptions(inventories, filters), [inventories, filters]);
  const invoice = invoices.includes(filters.invoice) ? filters.invoice : "";
  const report = useMemo(
    () => buildProductRanking(inventories, { ...filters, invoice }),
    [inventories, filters, invoice],
  );
  const patch = (partial: Partial<ProductRankFilters>) => setFilters((current) => ({ ...current, ...partial }));
  const inScope = scopeInventories(inventories, filters).length > 0;

  return (
    <Box sx={{ display: "grid", gap: 2 }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", gap: 2, alignItems: "center", flexWrap: "wrap" }}>
        <Box>
          <Typography variant="h5">Rentabilidad por producto</Typography>
          <Typography variant="body2" color="text.secondary">
            Cada fila es un producto de un inventario. El mismo nombre en otro inventario no se mezcla.
          </Typography>
        </Box>
        <Button variant="outlined" startIcon={<ArrowBackIcon />} onClick={onBack}>
          Volver
        </Button>
      </Box>

      <Card>
        <CardContent sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", lg: "repeat(3, 1fr)" } }}>
          <TextField
            label="Desde"
            type="date"
            value={filters.from}
            onChange={(event) => patch({ from: event.target.value })}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <TextField
            label="Hasta"
            type="date"
            value={filters.to}
            onChange={(event) => patch({ to: event.target.value })}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <TextField
            select
            label="Inventario"
            value={filters.inventoryId}
            onChange={(event) => patch({ inventoryId: event.target.value, invoice: "" })}
          >
            <MenuItem value="">Todos</MenuItem>
            {unique.map((item) => (
              <MenuItem key={item.id} value={item.id}>
                {inventoryLabel(item, unique)}
              </MenuItem>
            ))}
          </TextField>
          <TextField select label="Factura" value={invoice} onChange={(event) => patch({ invoice: event.target.value })}>
            <MenuItem value="">Todas</MenuItem>
            {invoices.map((code) => (
              <MenuItem key={code} value={code}>
                {code}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label="Producto"
            value={filters.query}
            onChange={(event) => patch({ query: event.target.value })}
            placeholder="Buscar por nombre"
          />
          <TextField
            select
            label="Estado"
            value={filters.status}
            onChange={(event) => patch({ status: event.target.value as ProductRankFilters["status"] })}
          >
            <MenuItem value="">Todos</MenuItem>
            <MenuItem value="rentable">Rentable</MenuItem>
            <MenuItem value="margen_bajo">Margen bajo</MenuItem>
            <MenuItem value="perdida">Pérdida</MenuItem>
            <MenuItem value="sin_rentabilidad">Sin rentabilidad</MenuItem>
          </TextField>
        </CardContent>
      </Card>

      {!inScope ? <Alert severity="warning">No hay inventarios en este filtro.</Alert> : null}

      <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", lg: "repeat(5, 1fr)" } }}>
        <Kpi label="Productos analizados" value={qty(report.totalProducts)} />
        <Kpi label="Rentables" value={qty(report.profitable)} hint="Neta positiva y margen mayor a 5%" />
        <Kpi label="Margen bajo" value={qty(report.lowMargin)} hint="Neta positiva y margen de 0% a 5%" />
        <Kpi label="Con pérdidas" value={qty(report.losses)} hint="Ganancia neta negativa" />
        <Kpi
          label="Mayor ganancia neta"
          value={report.top ? money(report.top.investorNet) : "—"}
          hint={report.top ? `${report.top.productName} · ${report.top.inventoryName}` : "Sin productos en el filtro"}
        />
      </Box>

      <Card>
        <CardContent>
          <Box sx={{ display: "flex", justifyContent: "space-between", gap: 2, flexWrap: "wrap", alignItems: "center", mb: 2 }}>
            <Typography variant="h6">Productos</Typography>
            <TextField
              select
              label="Ordenar por"
              value={filters.sort}
              onChange={(event) => patch({ sort: event.target.value as ProductRankSort })}
              sx={{ minWidth: 240 }}
            >
              <MenuItem value="net_desc">Mayor ganancia neta</MenuItem>
              <MenuItem value="net_asc">Menor ganancia neta</MenuItem>
              <MenuItem value="margin_desc">Mayor margen real</MenuItem>
              <MenuItem value="margin_asc">Menor margen real</MenuItem>
              <MenuItem value="sales_desc">Mayor venta</MenuItem>
              <MenuItem value="packages_desc">Mayor cantidad de paquetes</MenuItem>
            </TextField>
          </Box>
          {!report.rows.length ? (
            <Alert severity="info">No hay productos para este filtro.</Alert>
          ) : (
            <Box sx={{ overflowX: "auto" }}>
              <Table size="small" sx={{ minWidth: 1280 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>Producto</TableCell>
                    <TableCell>Inventario</TableCell>
                    <TableCell>Factura</TableCell>
                    <TableCell align="right">Paquetes</TableCell>
                    <TableCell align="right">Costo total de compra</TableCell>
                    <TableCell align="right">Logística asignada</TableCell>
                    <TableCell align="right">Precio de venta por paquete</TableCell>
                    <TableCell align="right">Venta total</TableCell>
                    <TableCell align="right">Margen real</TableCell>
                    <TableCell align="right">Comisión vendedor</TableCell>
                    <TableCell align="right">Ganancia neta inversionista</TableCell>
                    <TableCell>Estado</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {report.rows.map((row) => {
                    const tone = STATUS_STYLE[row.status];
                    return (
                      <TableRow key={row.id} hover>
                        <TableCell>{row.productName}</TableCell>
                        <TableCell>{row.inventoryName}</TableCell>
                        <TableCell>{row.invoice || "Sin factura"}</TableCell>
                        <TableCell align="right">{qty(row.packages)}</TableCell>
                        <TableCell align="right">{money(row.purchaseSubtotal)}</TableCell>
                        <TableCell align="right">{money(row.logisticsAllocated)}</TableCell>
                        <TableCell align="right">{money(row.appliedPrice)}</TableCell>
                        <TableCell align="right">{money(row.salesTotal)}</TableCell>
                        <TableCell align="right">{percent(row.realMarginPercent)}</TableCell>
                        <TableCell align="right">{money(row.vendorProfit)}</TableCell>
                        <TableCell align="right">{money(row.investorNet)}</TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            label={productStatusLabel(row.status)}
                            sx={{ bgcolor: tone.bg, color: tone.color, fontWeight: 600 }}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Box>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent>
        <Typography variant="overline" color="text.secondary">
          {label}
        </Typography>
        <Typography variant="h6" sx={{ mt: 0.5 }}>
          {value}
        </Typography>
        {hint ? (
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
            {hint}
          </Typography>
        ) : null}
      </CardContent>
    </Card>
  );
}
