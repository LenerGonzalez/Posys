import { useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
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
import MeasureFilterField from "./MeasureFilterField";
import { DEFAULT_MEASURE_FILTER, matchesMeasureFilter, type MeasureFilter } from "./measureFilter";
import { priceOrigin } from "./priceCatalog";
import { uniqueInventories } from "./profitability";
import { productMeasureUnit, type PriceMethod, type PricingInventory } from "./types";

function priceInputLabel(method: PriceMethod, manual: number | null, margin: number | null): string {
  if (method === "PRECIO") return money(manual ?? 0);
  return margin == null ? "Margen general" : percent(margin);
}

export default function ChangeHistory({
  inventories,
  onBack,
}: {
  inventories: PricingInventory[];
  onBack: () => void;
}) {
  const options = useMemo(() => uniqueInventories(inventories), [inventories]);
  const [inventoryId, setInventoryId] = useState("");
  const [measure, setMeasure] = useState<MeasureFilter>(DEFAULT_MEASURE_FILTER);
  const rows = useMemo(() => {
    return options
      .filter((item) => !inventoryId || item.id === inventoryId)
      .flatMap((item) =>
        item.history.map((snapshot) => ({
          inventoryId: item.id,
          inventoryName: item.name || "Sin nombre",
          snapshot,
        })),
      )
      .sort((left, right) => right.snapshot.savedAt.localeCompare(left.snapshot.savedAt));
  }, [options, inventoryId]);
  const priceChanges = useMemo(() => {
    return options
      .filter((item) => !inventoryId || item.id === inventoryId)
      .flatMap((item) =>
        (item.priceChanges ?? []).flatMap((change) => {
          const product = item.products.find((entry) => entry.id === change.productId);
          if (!matchesMeasureFilter(product ? product.unit : productMeasureUnit({}), measure)) return [];
          return [{
            inventoryName: item.name || "Sin nombre",
            change,
          }];
        }),
      )
      .sort((left, right) => right.change.changedAt.localeCompare(left.change.changedAt));
  }, [options, inventoryId, measure]);

  return (
    <Box sx={{ display: "grid", gap: { xs: 1.25, md: 2 } }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", gap: 2, alignItems: "center", flexWrap: "wrap" }}>
        <Box>
          <Typography variant="h5">Historial de cambios</Typography>
          <Typography variant="body2" color="text.secondary">
            Los guardados del inventario se conservan. Debajo queda cada cambio individual de precio.
          </Typography>
        </Box>
        <Button variant="outlined" startIcon={<ArrowBackIcon />} onClick={onBack}>
          Volver
        </Button>
      </Box>
      <Card>
        <CardContent sx={{ display: "grid", gap: { xs: 1.25, md: 2 } }}>
          <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "1fr", sm: "minmax(0, 360px) minmax(180px, 220px)" } }}>
          <TextField
            select
            label="Inventario"
            value={inventoryId}
            onChange={(event) => setInventoryId(event.target.value)}
          >
            <MenuItem value="">Todos</MenuItem>
            {options.map((item) => (
              <MenuItem key={item.id} value={item.id}>{item.name || "Sin nombre"}</MenuItem>
            ))}
          </TextField>
          <MeasureFilterField value={measure} onChange={setMeasure} />
          </Box>
          {measure !== "package" ? (
            <Alert severity="info">La cantidad guardada no se puede separar por unidad. Los importes siguen siendo los del inventario completo en ese momento.</Alert>
          ) : null}
          {!rows.length ? (
            <Alert severity="info">Todavía no hay guardados en este criterio.</Alert>
          ) : (
            <Box sx={{ overflowX: "auto" }}>
              <Table size="small" sx={{ minWidth: 980 }}>
                <TableHead>
                  <TableRow>
                    {["Guardado", "Inventario", "Productos", "Paquetes", "Compras", "Logística", "Venta", "Utilidad bruta", "Comisión", "Ganancia neta"].map((label) => (
                      <TableCell key={label} sx={{ whiteSpace: "nowrap" }}>{label}</TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={`${row.inventoryId}-${row.snapshot.savedAt}`} hover>
                      <TableCell sx={{ whiteSpace: "nowrap" }}>{dateTimeLabel(row.snapshot.savedAt)}</TableCell>
                      <TableCell>{row.inventoryName}</TableCell>
                      <TableCell>{qty(row.snapshot.productCount)}</TableCell>
                      <TableCell>{measure === "package" ? qty(row.snapshot.packages) : "—"}</TableCell>
                      <TableCell sx={{ whiteSpace: "nowrap" }}>{money(row.snapshot.purchaseSubtotal)}</TableCell>
                      <TableCell sx={{ whiteSpace: "nowrap" }}>{money(row.snapshot.logisticsCost)}</TableCell>
                      <TableCell sx={{ whiteSpace: "nowrap" }}>{money(row.snapshot.projectedSales)}</TableCell>
                      <TableCell sx={{ whiteSpace: "nowrap" }}>{money(row.snapshot.grossProfit)}</TableCell>
                      <TableCell sx={{ whiteSpace: "nowrap" }}>{money(row.snapshot.vendorProfit)}</TableCell>
                      <TableCell sx={{ whiteSpace: "nowrap", fontWeight: 700 }}>{money(row.snapshot.investorNet)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardContent sx={{ display: "grid", gap: { xs: 1.25, md: 2 } }}>
          <Typography variant="h6">Cambios de precio</Typography>
          {!priceChanges.length ? (
            <Alert severity="info">Todavía no hay cambios individuales de precio.</Alert>
          ) : (
            <Box sx={{ overflowX: "auto" }}>
              <Table size="small" sx={{ minWidth: 1100 }}>
                <TableHead>
                  <TableRow>
                    {["Fecha", "Usuario", "Inventario / Factura", "Producto", "Método", "Precio", "Margen real", "Entrada"].map((label) => (
                      <TableCell key={label} sx={{ whiteSpace: "nowrap" }}>{label}</TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {priceChanges.map((row) => (
                    <TableRow key={`${row.change.inventoryId}-${row.change.productId}-${row.change.changedAt}`} hover>
                      <TableCell sx={{ whiteSpace: "nowrap" }}>{dateTimeLabel(row.change.changedAt)}</TableCell>
                      <TableCell>{row.change.userEmail || row.change.userUid}</TableCell>
                      <TableCell>{priceOrigin(row.inventoryName, row.change.orderCode)}</TableCell>
                      <TableCell>{row.change.productName}</TableCell>
                      <TableCell sx={{ whiteSpace: "nowrap" }}>{row.change.previousMethod} → {row.change.nextMethod}</TableCell>
                      <TableCell sx={{ whiteSpace: "nowrap" }}>{money(row.change.previousAppliedPrice)} → {money(row.change.nextAppliedPrice)}</TableCell>
                      <TableCell sx={{ whiteSpace: "nowrap" }}>{percent(row.change.previousRealMarginPercent)} → {percent(row.change.nextRealMarginPercent)}</TableCell>
                      <TableCell sx={{ whiteSpace: "nowrap" }}>
                        {priceInputLabel(row.change.previousMethod, row.change.previousManualPrice, row.change.previousTargetMarginPercent)}
                        {" → "}
                        {priceInputLabel(row.change.nextMethod, row.change.nextManualPrice, row.change.nextTargetMarginPercent)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
