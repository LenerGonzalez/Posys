import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Collapse,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { money, percent, qty } from "./format";
import NumericField from "./NumericField";
import { upDesktop, useNarrowScreen } from "./screen";
import { commissionMethodLabel, type CommissionMethod, type ComputedLine, type PriceMethod, type ProductInput } from "./types";

function PriceCard({
  line,
  product,
  onChange,
  spacious,
  generalMarginPercent,
}: {
  line: ComputedLine;
  product: ProductInput;
  onChange: (patch: Partial<ProductInput>) => void;
  spacious?: boolean;
  generalMarginPercent?: number;
}) {
  return (
    <Card variant="outlined" sx={{ minWidth: 0 }}>
      <CardContent sx={{ display: "grid", gap: 1, p: 1.25 }}>
        <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1, alignItems: "flex-start" }}>
          <Typography variant="subtitle2" sx={{ overflowWrap: "anywhere", fontSize: "0.95rem" }}>{line.name}</Typography>
          <Chip size="small" label={line.priceMethod} />
        </Box>
        <Box sx={{ display: "grid", gap: 0.75, gridTemplateColumns: "1fr 1fr" }}>
          {[
            ["Paquetes", qty(line.packages)],
            ["Costo proveedor", money(line.costPerPack)],
            ["Logística / paquete", money(line.logisticsPerPack)],
            ["Precio costo", money(line.costPlusLogisticsPerPack)],
            ["Costo + logística", money(line.purchaseSubtotal + line.logisticsAllocated)],
            ["Precio de venta", money(line.appliedPrice, 0)],
            ["Margen real", percent(line.realMarginPercent)],
            ["Venta total", money(line.salesTotal)],
          ].map(([label, value]) => (
            <Box key={label} sx={{ minWidth: 0 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.15 }}>{label}</Typography>
              <Typography sx={{ fontWeight: 700, fontSize: "0.9rem", overflowWrap: "anywhere", color: label === "Precio de venta" ? "#1A56DB" : "text.primary" }}>{value}</Typography>
            </Box>
          ))}
        </Box>
        <PriceFields product={product} onChange={onChange} spacious={spacious} generalMarginPercent={generalMarginPercent} />
        <AlertRow line={line} />
      </CardContent>
    </Card>
  );
}

function usesGeneralMargin(product: ProductInput, generalMarginPercent?: number): boolean {
  return product.priceMethod === "MARGEN" && product.targetMarginPercent == null && generalMarginPercent != null;
}

function generalMarginHelp(generalMarginPercent?: number): string | undefined {
  if (generalMarginPercent == null) return undefined;
  return `Margen general de Configuración: ${percent(generalMarginPercent, 0)}`;
}

function PriceFields({
  product,
  onChange,
  spacious,
  generalMarginPercent,
}: {
  product: ProductInput;
  onChange: (patch: Partial<ProductInput>) => void;
  spacious?: boolean;
  generalMarginPercent?: number;
}) {
  const generalHelp = usesGeneralMargin(product, generalMarginPercent) ? generalMarginHelp(generalMarginPercent) : undefined;
  return (
    <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: spacious ? { xs: "1fr", [upDesktop]: "minmax(150px, 0.7fr) minmax(220px, 1fr) minmax(260px, 1fr)" } : { xs: "1fr 1fr", [upDesktop]: "140px 1fr 1fr" }, "& > :first-of-type": { gridColumn: { xs: "1 / -1", [upDesktop]: "auto" } } }}>
      <TextField
        select
        label="Método"
        value={product.priceMethod}
        onChange={(event) => onChange({ priceMethod: event.target.value as PriceMethod })}
      >
        <MenuItem value="MARGEN">MARGEN</MenuItem>
        <MenuItem value="PRECIO">PRECIO</MenuItem>
      </TextField>
      <NumericField
        label="Precio manual"
        kind="manualPrice"
        disabled={product.priceMethod !== "PRECIO"}
        value={product.manualPrice}
        adornment="C$"
        adornmentPosition="start"
        sx={spacious ? { minWidth: 200 } : undefined}
        onCommit={(value) => onChange({ manualPrice: value })}
      />
      <NumericField
        label="Margen del producto"
        kind="optionalMargin"
        disabled={product.priceMethod !== "MARGEN"}
        placeholder={generalHelp ? undefined : "Usa el general"}
        helperText={generalHelp}
        value={product.targetMarginPercent}
        adornment="%"
        sx={spacious ? { minWidth: 240 } : undefined}
        onCommit={(value) => onChange({ targetMarginPercent: value })}
      />
    </Box>
  );
}

function AlertRow({ line }: { line: ComputedLine }) {
  return (
    <Box sx={{ display: "grid", gap: 0.75 }}>
      {line.alerts.priceAtOrBelowCost ? (
        <Alert severity="error">Precio insuficiente: no cubre el costo más la logística.</Alert>
      ) : null}
      {line.alerts.lowMargin ? (
        <Alert severity="warning">Margen bajo: el margen real está entre 0 % y 5 %.</Alert>
      ) : null}
      {line.alerts.investorBelowVendor ? (
        <Alert severity="error">La ganancia neta del inversionista por paquete es menor que la del vendedor.</Alert>
      ) : null}
    </Box>
  );
}

export default function PricesList({
  lines,
  products,
  commissionMethod,
  onChangeProduct,
  spacious,
  generalMarginPercent,
}: {
  lines: ComputedLine[];
  products: ProductInput[];
  commissionMethod: CommissionMethod;
  onChangeProduct: (id: string, patch: Partial<ProductInput>) => void;
  spacious?: boolean;
  generalMarginPercent?: number;
}) {
  const byId = new Map(products.map((product) => [product.id, product]));
  const narrow = useNarrowScreen();
  const [rulesOpen, setRulesOpen] = useState(false);
  const rules = `En MARGEN, un margen vacío usa el de la configuración. En PRECIO, el precio manual tiene prioridad si es mayor que cero. El rojo marca un precio que no cubre costo más logística. Método en uso: ${commissionMethodLabel(commissionMethod)}. Los precios y el margen no cambian al elegir el método.`;
  return (
    <Box sx={{ display: "grid", gap: { xs: 1, md: 2 } }}>
      {narrow ? (
        <>
          <Button size="small" onClick={() => setRulesOpen((current) => !current)} sx={{ justifyContent: "flex-start", px: 0, minHeight: 32 }}>
            {rulesOpen ? "Ocultar reglas de precio" : "Ver reglas de precio"}
          </Button>
          <Collapse in={rulesOpen}>
            <Alert severity="info">{rules}</Alert>
          </Collapse>
        </>
      ) : (
        <Alert severity="info">{rules}</Alert>
      )}
      <Box sx={{ display: "grid", gap: 0.75, [upDesktop]: { display: "none" } }}>
        {lines.map((line) => {
          const product = byId.get(line.id);
          if (!product) return null;
          return (
            <PriceCard
              key={line.id}
              line={line}
              product={product}
              spacious={spacious}
              generalMarginPercent={generalMarginPercent}
              onChange={(patch) => onChangeProduct(line.id, patch)}
            />
          );
        })}
      </Box>
      <Card sx={{ display: "none", overflow: "auto", [upDesktop]: { display: "block" } }}>
        <Table size="small" stickyHeader sx={{ minWidth: spacious ? 1960 : 1660 }}>
          <TableHead>
            <TableRow>
              {[
                ["Producto", 220],
                ["Paquetes", 90],
                ["Costo proveedor", 170],
                ["Logística / paquete", 170],
                ["Precio Costo", 140],
                ["Costo + logística total", 180],
                ["Método", 140],
                [spacious ? "Precio manual" : "Manual", spacious ? 240 : 130],
                [spacious ? "Margen del producto" : "Margen", spacious ? 280 : 120],
                ["Precio", 120],
                ["Margen real", 130],
                ["Venta", 140],
              ].map(([label, width]) => (
                <TableCell key={label} sx={{ minWidth: width, whiteSpace: "nowrap" }}>
                  {label}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {lines.map((line) => {
              const product = byId.get(line.id);
              if (!product) return null;
              return (
                <TableRow key={line.id} hover>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{line.name}</Typography>
                    <Typography variant="caption" color="text.secondary">{line.orderCode || "Sin orden"}</Typography>
                  </TableCell>
                  <TableCell sx={{ whiteSpace: "nowrap" }}>{qty(line.packages)}</TableCell>
                  <TableCell sx={{ whiteSpace: "nowrap" }}>{money(line.costPerPack)}</TableCell>
                  <TableCell sx={{ whiteSpace: "nowrap" }}>{money(line.logisticsPerPack)}</TableCell>
                  <TableCell sx={{ whiteSpace: "nowrap" }}>{money(line.costPlusLogisticsPerPack)}</TableCell>
                  <TableCell sx={{ whiteSpace: "nowrap" }}>{money(line.purchaseSubtotal + line.logisticsAllocated)}</TableCell>
                  <TableCell sx={{ minWidth: 130 }}>
                    <TextField
                      select
                      value={product.priceMethod}
                      onChange={(event) =>
                        onChangeProduct(line.id, { priceMethod: event.target.value as PriceMethod })
                      }
                    >
                      <MenuItem value="MARGEN">MARGEN</MenuItem>
                      <MenuItem value="PRECIO">PRECIO</MenuItem>
                    </TextField>
                  </TableCell>
                  <TableCell sx={{ minWidth: spacious ? 240 : 120 }}>
                    <NumericField
                      label={spacious ? "Precio manual" : undefined}
                      kind="manualPrice"
                      disabled={product.priceMethod !== "PRECIO"}
                      value={product.manualPrice}
                      adornment="C$"
                      adornmentPosition="start"
                      sx={spacious ? { minWidth: 210 } : undefined}
                      onCommit={(value) => onChangeProduct(line.id, { manualPrice: value })}
                    />
                  </TableCell>
                  <TableCell sx={{ minWidth: spacious ? 280 : 110 }}>
                    <NumericField
                      label={spacious ? "Margen" : undefined}
                      kind="optionalMargin"
                      disabled={product.priceMethod !== "MARGEN"}
                      value={product.targetMarginPercent}
                      adornment="%"
                      placeholder={usesGeneralMargin(product, generalMarginPercent) ? undefined : "General"}
                      helperText={usesGeneralMargin(product, generalMarginPercent) ? generalMarginHelp(generalMarginPercent) : undefined}
                      sx={spacious ? { minWidth: 250 } : undefined}
                      onCommit={(value) =>
                        onChangeProduct(line.id, { targetMarginPercent: value })
                      }
                    />
                  </TableCell>
                  <TableCell sx={{ color: line.alerts.priceAtOrBelowCost ? "error.main" : "text.primary", fontWeight: 700, whiteSpace: "nowrap", minWidth: 120 }}>
                    {money(line.appliedPrice, 0)}
                  </TableCell>
                  <TableCell sx={{ color: line.alerts.lowMargin ? "warning.main" : "success.main", fontWeight: 700, whiteSpace: "nowrap", minWidth: 130 }}>
                    {percent(line.realMarginPercent)}
                  </TableCell>
                  <TableCell sx={{ whiteSpace: "nowrap", minWidth: 140 }}>{money(line.salesTotal)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
    </Box>
  );
}
