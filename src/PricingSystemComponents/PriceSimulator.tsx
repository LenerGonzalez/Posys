import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
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
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { money, percent } from "./format";
import { computeInventory } from "./pricingEngine";
import { portfolioRates, uniqueInventories } from "./profitability";
import PricesList from "./PricesList";
import { useNarrowScreen } from "./screen";
import Settings from "./Settings";
import type { ComputedTotals, PricingInventory, ProductInput } from "./types";

function copyInventory(item: PricingInventory): PricingInventory {
  return {
    ...item,
    settings: { ...item.settings },
    products: item.products.map((product) => ({ ...product })),
    history: item.history,
  };
}

export type SimulationSense = "higher" | "lower" | "neutral";
export type SimulationTone = "good" | "bad" | "flat";

export interface SimulationMetric {
  key: string;
  label: string;
  sense: SimulationSense;
  kind: "money" | "roi";
  current: number;
  simulated: number;
  currentNet: number;
  simulatedNet: number;
}

const TONE_COLOR = {
  good: "#0D652D",
  bad: "#C5221F",
  flat: "#5F6368",
};

export function simulationTone(delta: number, sense: SimulationSense): SimulationTone {
  if (sense === "neutral" || Math.abs(delta) < 1e-9) return "flat";
  const improved = sense === "lower" ? delta < 0 : delta > 0;
  return improved ? "good" : "bad";
}

export function simulationMetrics(current: ComputedTotals, simulated: ComputedTotals): SimulationMetric[] {
  const currentRates = portfolioRates(
    current.grossProfit,
    current.projectedSales,
    current.investorNet,
    current.purchaseSubtotal,
    current.logisticsCost,
  );
  const simulatedRates = portfolioRates(
    simulated.grossProfit,
    simulated.projectedSales,
    simulated.investorNet,
    simulated.purchaseSubtotal,
    simulated.logisticsCost,
  );
  const moneyRow = (
    key: keyof ComputedTotals,
    label: string,
    sense: SimulationSense,
  ): SimulationMetric => ({
    key,
    label,
    sense,
    kind: "money",
    current: Number(current[key]),
    simulated: Number(simulated[key]),
    currentNet: current.investorNet,
    simulatedNet: simulated.investorNet,
  });
  return [
    moneyRow("purchaseSubtotal", "Inversión en compras", "lower"),
    moneyRow("logisticsCost", "Gastos logísticos", "lower"),
    moneyRow("costWithLogistics", "Costo total con logística", "lower"),
    moneyRow("projectedSales", "Venta proyectada", "higher"),
    moneyRow("grossProfit", "Utilidad bruta", "higher"),
    moneyRow("commissionBase", "Base para comisión", "neutral"),
    moneyRow("vendorProfit", "Comisión del vendedor", "lower"),
    moneyRow("investorNet", "Ganancia neta del inversionista", "higher"),
    {
      key: "roi",
      label: "ROI",
      sense: "higher",
      kind: "roi",
      current: currentRates.roiPercent,
      simulated: simulatedRates.roiPercent,
      currentNet: current.investorNet,
      simulatedNet: simulated.investorNet,
    },
  ];
}

function signed(kind: "money" | "percent", value: number): string {
  const text = kind === "money" ? money(value) : percent(value);
  return value > 1e-9 ? `+${text}` : text;
}

function Amount({
  metric,
  side,
}: {
  metric: SimulationMetric;
  side: "current" | "simulated" | "delta";
}) {
  const value = side === "delta" ? metric.simulated - metric.current : metric[side];
  const net = side === "delta"
    ? metric.simulatedNet - metric.currentNet
    : side === "current"
      ? metric.currentNet
      : metric.simulatedNet;
  const tone = side === "delta" ? simulationTone(value, metric.sense) : "flat";
  const main = metric.kind === "roi"
    ? (side === "delta" ? signed("percent", value) : percent(value))
    : (side === "delta" ? signed("money", value) : money(value));
  const netText = side === "delta" ? signed("money", net) : money(net);
  return (
    <Box>
      <Typography variant="body2" sx={{ fontWeight: side === "current" ? 500 : 700, color: side === "delta" ? TONE_COLOR[tone] : "text.primary" }}>
        {main}
      </Typography>
      {metric.kind === "roi" ? (
        <Typography variant="caption" color="text.secondary" component="div">
          Neta {netText}
        </Typography>
      ) : null}
    </Box>
  );
}

export default function PriceSimulator({
  inventories,
  onBack,
}: {
  inventories: PricingInventory[];
  onBack: () => void;
}) {
  const options = useMemo(() => uniqueInventories(inventories), [inventories]);
  const [inventoryId, setInventoryId] = useState("");
  const source = options.find((item) => item.id === inventoryId) ?? null;
  const [draft, setDraft] = useState<PricingInventory | null>(null);
  const narrow = useNarrowScreen();
  const [legendOpen, setLegendOpen] = useState(false);

  useEffect(() => {
    setDraft(source ? copyInventory(source) : null);
  }, [source]);

  const baseline = source ? computeInventory(source) : null;
  const simulated = draft ? computeInventory(draft) : null;
  const metrics = baseline && simulated ? simulationMetrics(baseline.totals, simulated.totals) : [];

  const patchProduct = (id: string, patch: Partial<ProductInput>) => {
    setDraft((current) => current ? {
      ...current,
      products: current.products.map((product) => product.id === id ? { ...product, ...patch } : product),
    } : current);
  };

  return (
    <Box sx={{ display: "grid", gap: { xs: 1.25, md: 2 } }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", gap: 2, alignItems: "center", flexWrap: "wrap" }}>
        <Box>
          <Typography variant="h5">Simulador de precios</Typography>
          <Typography variant="body2" color="text.secondary">
            Prueba precios, márgenes y el método de comisión. El inventario guardado no se modifica.
          </Typography>
        </Box>
        <Button variant="outlined" startIcon={<ArrowBackIcon />} onClick={onBack}>
          Volver
        </Button>
      </Box>

      <Card>
        <CardContent sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "minmax(0, 1fr) auto", md: "minmax(260px, 1fr) auto" }, alignItems: "center" }}>
          <TextField
            select
            label="Inventario"
            value={inventoryId}
            onChange={(event) => setInventoryId(event.target.value)}
            sx={{ minWidth: 0 }}
          >
            <MenuItem value="">Seleccionar</MenuItem>
            {options.map((item) => (
              <MenuItem key={item.id} value={item.id}>{item.name || "Sin nombre"}</MenuItem>
            ))}
          </TextField>
          <Button variant="text" disabled={!source} onClick={() => source && setDraft(copyInventory(source))}>
            Restaurar
          </Button>
        </CardContent>
      </Card>

      {!options.length ? <Alert severity="info">No hay inventarios guardados para simular.</Alert> : null}
      {options.length && !draft ? <Alert severity="info">Selecciona un inventario para simular sus precios.</Alert> : null}

      {draft && baseline && simulated ? (
        <>
          <Alert severity="info">
            Esta simulación usa el cálculo actual del inventario y no se escribe en Firestore.
          </Alert>
          <Settings
            settings={draft.settings}
            onChange={(settings) => setDraft((current) => current ? { ...current, settings } : current)}
          />
          <Card>
            <CardContent sx={{ overflowX: "auto" }}>
              <Typography variant="h6">Resultado simulado</Typography>
              {narrow ? (
                <>
                  <Button size="small" onClick={() => setLegendOpen((current) => !current)} sx={{ justifyContent: "flex-start", px: 0, minHeight: 32 }}>
                    {legendOpen ? "Ocultar lectura de colores" : "Ver lectura de colores"}
                  </Button>
                  <Collapse in={legendOpen}>
                    <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.4, mb: 1 }}>
                      Verde indica una mejora y rojo un resultado desfavorable. En compras, logística, costo total y comisión, disminuir es favorable. En venta, utilidad, ganancia neta y ROI, aumentar es favorable. La base de comisión no se colorea: una base menor no siempre conviene.
                    </Typography>
                  </Collapse>
                </>
              ) : (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 1.5, lineHeight: 1.4 }}>
                  Verde indica una mejora y rojo un resultado desfavorable. En compras, logística, costo total y comisión, disminuir es favorable. En venta, utilidad, ganancia neta y ROI, aumentar es favorable. La base de comisión no se colorea: una base menor no siempre conviene.
                </Typography>
              )}
              <Table size="small" sx={{ minWidth: 720 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>Indicador</TableCell>
                    <TableCell align="right">Inventario actual</TableCell>
                    <TableCell align="right">Simulación</TableCell>
                    <TableCell align="right">Diferencia</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {metrics.map((metric) => (
                    <TableRow key={metric.key} hover>
                      <TableCell>{metric.label}</TableCell>
                      <TableCell align="right"><Amount metric={metric} side="current" /></TableCell>
                      <TableCell align="right"><Amount metric={metric} side="simulated" /></TableCell>
                      <TableCell align="right"><Amount metric={metric} side="delta" /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <PricesList
            lines={simulated.lines}
            products={draft.products}
            commissionMethod={simulated.totals.commissionMethod}
            onChangeProduct={patchProduct}
            spacious
            generalMarginPercent={draft.settings.targetMarginPercent}
          />
        </>
      ) : null}
    </Box>
  );
}
