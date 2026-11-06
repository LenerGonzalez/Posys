import {
  Alert,
  Box,
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
import { money, percent, qty } from "./format";
import NumericField from "./NumericField";
import { upDesktop } from "./screen";
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
      <CardContent sx={{ display: "grid", gap: 1.25, p: { xs: 1.75, sm: 2 } }}>
        <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1 }}>
          <Typography variant="subtitle2" sx={{ overflowWrap: "anywhere", fontSize: "1.05rem" }}>{line.name}</Typography>
          <Chip size="small" label={line.priceMethod} />
        </Box>
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
          <Chip size="small" variant="outlined" label={`Costo ${money(line.costPerPack)}`} sx={{ "& .MuiChip-label": { whiteSpace: "nowrap" } }} />
          <Chip size="small" variant="outlined" label={`Logística ${money(line.logisticsPerPack)}`} sx={{ "& .MuiChip-label": { whiteSpace: "nowrap" } }} />
          <Chip size="small" variant="outlined" label={`Paquetes ${qty(line.packages)}`} sx={{ "& .MuiChip-label": { whiteSpace: "nowrap" } }} />
          <Chip size="small" variant="outlined" label={`Precio Costo ${money(line.costPlusLogisticsPerPack)}`} sx={{ "& .MuiChip-label": { whiteSpace: "nowrap" } }} />
          <Chip size="small" variant="outlined" label={`Costo + logística total ${money(line.purchaseSubtotal + line.logisticsAllocated)}`} sx={{ "& .MuiChip-label": { whiteSpace: "nowrap" } }} />
        </Box>
        <PriceFields product={product} onChange={onChange} spacious={spacious} generalMarginPercent={generalMarginPercent} />
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
          <Chip
            size="small"
            color={line.alerts.priceAtOrBelowCost ? "error" : "default"}
            label={`Precio ${money(line.appliedPrice, 0)}`}
            sx={{ "& .MuiChip-label": { whiteSpace: "nowrap" }, fontWeight: 700 }}
          />
          <Chip
            size="small"
            color={line.alerts.lowMargin ? "warning" : "success"}
            label={`Margen ${percent(line.realMarginPercent)}`}
            sx={{ "& .MuiChip-label": { whiteSpace: "nowrap" }, fontWeight: 700 }}
          />
          <Chip
            size="small"
            label={`Venta ${money(line.salesTotal)}`}
            sx={{ "& .MuiChip-label": { whiteSpace: "nowrap" }, fontWeight: 700 }}
          />
        </Box>
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
    <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: spacious ? { xs: "1fr", [upDesktop]: "minmax(150px, 0.7fr) minmax(220px, 1fr) minmax(260px, 1fr)" } : { xs: "1fr", [upDesktop]: "140px 1fr 1fr" } }}>
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
  return (
    <Box sx={{ display: "grid", gap: 2 }}>
      <Alert severity="info">
        En MARGEN, un margen vacío usa el de la configuración. En PRECIO, el precio manual tiene prioridad si es mayor que cero. El rojo marca un precio que no cubre costo más logística. Método en uso: {commissionMethodLabel(commissionMethod)}. Los precios y el margen no cambian al elegir el método.
      </Alert>
      <Box sx={{ display: "grid", gap: 1.5, [upDesktop]: { display: "none" } }}>
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
