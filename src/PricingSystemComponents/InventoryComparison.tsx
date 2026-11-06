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
import { dateTimeLabel, money, percent, qty } from "./format";
import { computeInventory } from "./pricingEngine";
import { uniqueInventories } from "./profitability";
import {
  compareInventories,
  type MetricCell,
  type MetricKind,
  type ProductSide,
} from "./compareInventories";
import type { PricingInventory } from "./types";

const MARK = {
  best_profit: { label: "Mejor rentabilidad", bg: "#E6F4EA", color: "#0D652D" },
  highest_volume: { label: "Mayor volumen", bg: "#E8F0FE", color: "#0842A0" },
  lowest_cost: { label: "Menor costo", bg: "#FEF4D6", color: "#6B3E00" },
};

function formatValue(kind: MetricKind, value: number): string {
  if (kind === "money") return money(value);
  if (kind === "percent") return percent(value);
  return qty(value);
}

function formatDelta(kind: MetricKind, cell: MetricCell): string {
  if (cell.delta == null) return "Referencia";
  const signed = (text: string) => `${cell.delta != null && cell.delta > 0 ? "+" : ""}${text}`;
  const amount = kind === "percent" ? signed(percent(cell.delta)) : kind === "qty" ? signed(qty(cell.delta)) : signed(money(cell.delta));
  if (cell.deltaPercent == null) return amount;
  const percentSign = cell.deltaPercent > 0 ? "+" : "";
  return `${amount} · ${percentSign}${percent(cell.deltaPercent)}`;
}

function optionFacts(item: PricingInventory) {
  const codes = [...new Set(item.products.map((product) => product.orderCode.trim()).filter(Boolean))];
  const saved = [...item.history].reduce<string | null>((best, entry) => {
    if (!entry.savedAt) return best;
    return !best || entry.savedAt > best ? entry.savedAt : best;
  }, null);
  return {
    invoices: codes.sort((left, right) => left.localeCompare(right, "es")).join(" · ") || "Sin factura",
    savedAt: saved || item.updatedAt || item.createdAt,
    productCount: computeInventory(item).totals.productCount,
  };
}

function GroupedChart({
  title,
  caption,
  left,
  right,
  inventories,
}: {
  title: string;
  caption: string;
  left: { name: string; color: string; value: (index: number) => number; text: (index: number) => string };
  right: { name: string; color: string; value: (index: number) => number; text: (index: number) => string };
  inventories: { name: string }[];
}) {
  const max = Math.max(
    0,
    ...inventories.flatMap((_, index) => [left.value(index), right.value(index)].map((value) => Math.max(value, 0))),
  );
  return (
    <Card>
      <CardContent>
        <Typography variant="h6">{title}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
          {caption}
        </Typography>
        <Box sx={{ display: "grid", gap: 2 }}>
          {inventories.map((inventory, index) => (
            <Box key={`${inventory.name}-${index}`}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>{inventory.name}</Typography>
              {[left, right].map((series) => {
                const value = series.value(index);
                const width = max > 0 ? (Math.max(value, 0) / max) * 100 : 0;
                return (
                  <Box key={series.name} sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "180px 1fr" }, gap: 1, alignItems: "center", mb: 0.75 }}>
                    <Box>
                      <Typography variant="body2">{series.name}</Typography>
                      <Typography variant="body2" sx={{ fontWeight: 700 }}>{series.text(index)}</Typography>
                    </Box>
                    <Box sx={{ height: 12, borderRadius: 999, bgcolor: "#E8EAED", overflow: "hidden" }}>
                      <Box sx={{ width: `${width}%`, height: "100%", bgcolor: series.color }} />
                    </Box>
                  </Box>
                );
              })}
            </Box>
          ))}
        </Box>
      </CardContent>
    </Card>
  );
}

export default function InventoryComparison({
  inventories,
  onBack,
}: {
  inventories: PricingInventory[];
  onBack: () => void;
}) {
  const options = useMemo(() => uniqueInventories(inventories), [inventories]);
  const [ids, setIds] = useState<string[]>(["", ""]);
  const comparison = useMemo(() => compareInventories(options, ids), [options, ids]);
  const setAt = (index: number, value: string) => {
    setIds((current) => current.map((id, position) => (position === index ? value : id)));
  };

  return (
    <Box sx={{ display: "grid", gap: 2 }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", gap: 2, alignItems: "center", flexWrap: "wrap" }}>
        <Box>
          <Typography variant="h5">Comparación de inventarios</Typography>
          <Typography variant="body2" color="text.secondary">
            Compara el cálculo actual de 2 a 5 inventarios. Cada producto conserva su inventario de origen.
          </Typography>
        </Box>
        <Button variant="outlined" startIcon={<ArrowBackIcon />} onClick={onBack}>
          Volver
        </Button>
      </Box>

      <Card>
        <CardContent sx={{ display: "grid", gap: 1.5 }}>
          <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1, flexWrap: "wrap", alignItems: "center" }}>
            <Typography variant="h6">Inventarios</Typography>
            <Box sx={{ display: "flex", gap: 1 }}>
              <Button variant="outlined" disabled={ids.length >= 5 || ids.length >= options.length} onClick={() => setIds((current) => [...current, ""])}>
                Agregar
              </Button>
              <Button variant="text" disabled={ids.length <= 2} onClick={() => setIds((current) => current.slice(0, -1))}>
                Quitar
              </Button>
            </Box>
          </Box>
          {options.length < 2 ? <Alert severity="info">Hacen falta al menos dos inventarios guardados para comparar.</Alert> : null}
          <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}>
            {ids.map((selected, index) => {
              const item = options.find((option) => option.id === selected);
              const facts = item ? optionFacts(item) : null;
              return (
                <Box key={`slot-${index}`}>
                  <TextField
                    select
                    fullWidth
                    label={`Inventario ${index + 1}`}
                    value={selected}
                    onChange={(event) => setAt(index, event.target.value)}
                  >
                    <MenuItem value="">Seleccionar</MenuItem>
                    {options.map((option) => {
                      const taken = ids.some((id, position) => position !== index && id === option.id);
                      const info = optionFacts(option);
                      return (
                        <MenuItem key={option.id} value={option.id} disabled={taken}>
                          {option.name || "Sin nombre"} · {info.invoices} · {qty(info.productCount)} productos
                        </MenuItem>
                      );
                    })}
                  </TextField>
                  {facts ? (
                    <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
                      Factura: {facts.invoices} · Último guardado: {dateTimeLabel(facts.savedAt)} · {qty(facts.productCount)} productos
                    </Typography>
                  ) : null}
                </Box>
              );
            })}
          </Box>
        </CardContent>
      </Card>

      {!comparison ? <Alert severity="info">Selecciona al menos dos inventarios distintos.</Alert> : null}

      {comparison ? (
        <>
          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
            <Chip size="small" label="Mejor rentabilidad" sx={{ bgcolor: MARK.best_profit.bg, color: MARK.best_profit.color, fontWeight: 600 }} />
            <Chip size="small" label="Mayor volumen, no es mayor rentabilidad" sx={{ bgcolor: MARK.highest_volume.bg, color: MARK.highest_volume.color, fontWeight: 600 }} />
            <Chip size="small" label="Menor costo, no es mayor rentabilidad" sx={{ bgcolor: MARK.lowest_cost.bg, color: MARK.lowest_cost.color, fontWeight: 600 }} />
          </Box>
          <Card>
            <CardContent sx={{ overflowX: "auto" }}>
              <Typography variant="h6" sx={{ mb: 1 }}>Indicadores</Typography>
              <Table size="small" sx={{ minWidth: 720 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>Indicador</TableCell>
                    {comparison.inventories.map((inventory) => (
                      <TableCell key={inventory.id} align="right">
                        <Box>
                          <Typography variant="body2" sx={{ fontWeight: 700 }}>{inventory.name}</Typography>
                          <Typography variant="caption" color="text.secondary" component="div">
                            {inventory.invoices}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" component="div">
                            Guardado {dateTimeLabel(inventory.savedAt)}
                          </Typography>
                        </Box>
                      </TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {comparison.metrics.map((metric) => (
                    <TableRow key={metric.key} hover>
                      <TableCell>{metric.label}</TableCell>
                      {metric.cells.map((cell, index) => (
                        <TableCell key={`${metric.key}-${comparison.inventories[index].id}`} align="right">
                          <Typography variant="body2" sx={{ fontWeight: 700 }}>{formatValue(metric.kind, cell.value)}</Typography>
                          <Typography variant="caption" color="text.secondary" component="div">{formatDelta(metric.kind, cell)}</Typography>
                          {cell.mark ? (
                            <Chip
                              size="small"
                              label={MARK[cell.mark].label}
                              sx={{ mt: 0.5, bgcolor: MARK[cell.mark].bg, color: MARK[cell.mark].color, fontWeight: 600 }}
                            />
                          ) : null}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Box sx={{ display: "grid", gap: 2 }}>
            <GroupedChart
              title="Inversión frente a venta"
              caption="La venta más alta no significa mayor rentabilidad."
              inventories={comparison.inventories}
              left={{
                name: "Inversión en compras",
                color: "#1A73E8",
                value: (index) => comparison.inventories[index].purchaseSubtotal,
                text: (index) => money(comparison.inventories[index].purchaseSubtotal),
              }}
              right={{
                name: "Venta proyectada",
                color: "#E8710A",
                value: (index) => comparison.inventories[index].projectedSales,
                text: (index) => money(comparison.inventories[index].projectedSales),
              }}
            />
            <GroupedChart
              title="Utilidad bruta frente a ganancia neta"
              caption="La ganancia neta ya descuenta la comisión y la logística de cada inventario."
              inventories={comparison.inventories}
              left={{
                name: "Utilidad bruta",
                color: "#E8710A",
                value: (index) => comparison.inventories[index].grossProfit,
                text: (index) => money(comparison.inventories[index].grossProfit),
              }}
              right={{
                name: "Ganancia neta",
                color: "#1E8E3E",
                value: (index) => Math.max(comparison.inventories[index].investorNet, 0),
                text: (index) => money(comparison.inventories[index].investorNet),
              }}
            />
            <GroupedChart
              title="ROI y margen ponderado"
              caption="El margen está ponderado por la venta. El ROI usa la ganancia neta sobre compra más logística."
              inventories={comparison.inventories}
              left={{
                name: "ROI",
                color: "#1E8E3E",
                value: (index) => comparison.inventories[index].roiPercent,
                text: (index) => percent(comparison.inventories[index].roiPercent),
              }}
              right={{
                name: "Margen ponderado",
                color: "#1A73E8",
                value: (index) => comparison.inventories[index].weightedMarginPercent,
                text: (index) => percent(comparison.inventories[index].weightedMarginPercent),
              }}
            />
          </Box>

          <Card>
            <CardContent sx={{ overflowX: "auto" }}>
              <Typography variant="h6">Productos en más de un inventario</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
                El mismo nombre se alinea para comparar, pero cada columna conserva el costo y el resultado de su inventario. No se suman entre sí.
              </Typography>
              {!comparison.products.length ? (
                <Alert severity="info">Ningún producto aparece en más de uno de los inventarios seleccionados.</Alert>
              ) : (
                <Table size="small" sx={{ minWidth: 960 }}>
                  <TableHead>
                    <TableRow>
                      <TableCell>Producto</TableCell>
                      {comparison.inventories.map((inventory) => (
                        <TableCell key={inventory.id}>{inventory.name}</TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {comparison.products.map((row) => (
                      <TableRow key={row.id} hover>
                        <TableCell>{row.label}</TableCell>
                        {row.sides.map((side) => (
                          <TableCell key={`${row.id}-${side.inventoryId}`}>
                            <ProductCell side={side} />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </Box>
  );
}

function ProductCell({ side }: { side: ProductSide }) {
  if (!side.available) {
    return <Typography variant="body2" color="text.secondary">No disponible</Typography>;
  }
  return (
    <Box sx={{ display: "grid", gap: 0.25 }}>
      <Typography variant="caption" color="text.secondary">{side.inventoryName}</Typography>
      <Typography variant="body2">Costo/paq {money(side.costPerPack ?? 0)}</Typography>
      <Typography variant="body2">Precio/paq {money(side.appliedPrice ?? 0)}</Typography>
      <Typography variant="body2">Paquetes {qty(side.packages ?? 0)}</Typography>
      <Typography variant="body2">Margen {percent(side.realMarginPercent ?? 0)}</Typography>
      <Typography variant="body2" sx={{ fontWeight: 700 }}>Neta/paq {money(side.investorNetPerPack ?? 0)}</Typography>
    </Box>
  );
}
