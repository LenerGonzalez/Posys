import { useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Alert,
  Box,
  Card,
  CardContent,
  IconButton,
  MenuItem,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import {
  Area,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { money, percent, qty } from "./format";
import { computeInventory } from "./pricingEngine";
import {
  buildProfitability,
  EMPTY_PROFITABILITY_FILTERS,
  invoiceOptions,
  scopeInventories,
  uniqueInventories,
  type ProfitabilityEvolution,
  type ProfitabilityFilters,
} from "./profitability";
import { metricCellSx, upDesktop } from "./screen";
import type { PricingInventory } from "./types";

/** Grosor, en píxeles, de las barras horizontales de costos y de venta. */
const METER_HEIGHT = 18;

const COLORS = {
  compra: "#1A73E8",
  logistica: "#E8710A",
  comision: "#80868B",
  venta: "#1A73E8",
  bruta: "#E8710A",
  neta: "#1E8E3E",
  track: "#E8EAED",
};

function HelpTip({ label, help }: { label: string; help: string }) {
  return (
    <Tooltip title={help} arrow describeChild>
      <IconButton size="small" aria-label={`Ayuda sobre ${label}`} sx={{ p: 0.25 }}>
        <InfoOutlinedIcon sx={{ fontSize: 16, color: "text.secondary" }} />
      </IconButton>
    </Tooltip>
  );
}

function Kpi({
  label,
  value,
  hint,
  help,
}: {
  label: string;
  value: string;
  hint?: ReactNode;
  help: string;
}) {
  return (
    <Box sx={metricCellSx}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.2 }}>
          {label}
        </Typography>
        <HelpTip label={label} help={help} />
      </Box>
      <Typography sx={{ mt: 0.25, fontWeight: 800, overflowWrap: "anywhere", fontSize: { xs: "0.95rem", md: "1.35rem" } }}>
        {value}
      </Typography>
      {hint ? (
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.25 }}>
          {hint}
        </Typography>
      ) : null}
    </Box>
  );
}

function ChartTitle({ title, help }: { title: string; help: string }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
      <Typography variant="h6">{title}</Typography>
      <HelpTip label={title} help={help} />
    </Box>
  );
}

function MeterRow({
  label,
  amount,
  width,
  color,
  detail,
}: {
  label: string;
  amount: string;
  width: number;
  color: string;
  detail?: string;
}) {
  return (
    <Box>
      <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1, alignItems: "baseline", flexWrap: "wrap" }}>
        <Typography variant="body2">{label}</Typography>
        <Typography variant="body2" sx={{ fontWeight: 600, textAlign: "right", overflowWrap: "anywhere" }}>
          {detail ? `${amount} · ${detail}` : amount}
        </Typography>
      </Box>
      <Box sx={{ mt: 0.75, height: METER_HEIGHT, borderRadius: 999, bgcolor: COLORS.track, overflow: "hidden" }}>
        <Box
          sx={{
            width: `${Math.max(0, Math.min(100, width))}%`,
            height: "100%",
            borderRadius: 999,
            bgcolor: width > 0 ? color : "transparent",
          }}
        />
      </Box>
    </Box>
  );
}

function shareText(share: number): string {
  if (Math.abs(share) < 0.05) return "0%";
  const rounded = Math.round(share * 10) / 10;
  return percent(share, Number.isInteger(rounded) ? 0 : 1);
}

function axisMoney(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000) {
    const compact = value / 1000;
    return `C$ ${compact.toLocaleString("es-NI", { maximumFractionDigits: abs >= 10000 ? 0 : 1 })}k`;
  }
  return money(value);
}

function formatStamp(value: string | number, withYear = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("es-NI", {
    day: "2-digit",
    month: "short",
    year: withYear ? "numeric" : undefined,
    hour: "2-digit",
    minute: "2-digit",
  });
}

type EvolutionPoint = {
  savedAt: number;
  grossProfit: number;
  investorNet: number;
  inventoryName: string;
  /** El guardado más reciente de ese inventario, con el mismo cálculo que los indicadores. */
  current: boolean;
  indicatorsNet: number;
};

type EvolutionSeries = {
  id: string;
  name: string;
  color: string;
  points: EvolutionPoint[];
};

const SERIES_COLORS = ["#E8710A", "#1A73E8", "#1E8E3E", "#A142F4", "#129EAF", "#C5221F"];

function evolutionSeries(
  rows: ProfitabilityEvolution[],
  currentByInventory: Map<string, { grossProfit: number; investorNet: number; latestSavedAt: number | null }>,
  indicatorsNet: number,
): EvolutionSeries[] {
  const order: string[] = [];
  const groups = new Map<string, EvolutionSeries>();
  rows.forEach((row) => {
    const savedAt = new Date(row.savedAt).getTime();
    if (Number.isNaN(savedAt)) return;
    let series = groups.get(row.inventoryId);
    if (!series) {
      series = {
        id: row.inventoryId,
        name: row.inventoryName || "Sin nombre",
        color: SERIES_COLORS[order.length % SERIES_COLORS.length],
        points: [],
      };
      groups.set(row.inventoryId, series);
      order.push(row.inventoryId);
    }
    series.points.push({
      savedAt,
      grossProfit: row.grossProfit,
      investorNet: row.investorNet,
      inventoryName: series.name,
      current: false,
      indicatorsNet,
    });
  });
  const nameCount = new Map<string, number>();
  order.forEach((id) => {
    const name = groups.get(id)!.name;
    nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
  });
  return order.map((id) => {
    const series = groups.get(id)!;
    if ((nameCount.get(series.name) ?? 0) > 1) {
      series.name = `${series.name} · ${series.id.slice(0, 6)}`;
      series.points.forEach((point) => {
        point.inventoryName = series.name;
      });
    }
    series.points.sort((left, right) => left.savedAt - right.savedAt);
    const current = currentByInventory.get(series.id);
    const last = series.points[series.points.length - 1];
    if (current && last && current.latestSavedAt != null && last.savedAt === current.latestSavedAt) {
      last.grossProfit = current.grossProfit;
      last.investorNet = current.investorNet;
      last.current = true;
    }
    return series;
  });
}

function profitDomain(items: EvolutionSeries[]): [number, number] {
  const values = items.flatMap((item) => item.points.flatMap((point) => [point.grossProfit, point.investorNet]));
  if (!values.length) return [0, 1];
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || Math.max(Math.abs(max), 1);
  return [min, max + span * 0.08];
}

function EvolutionTip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: EvolutionPoint }>;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <Box
      sx={{
        bgcolor: "#fff",
        border: "1px solid #E8EAED",
        borderRadius: 2,
        px: 1.5,
        py: 1,
        boxShadow: "0 1px 4px rgba(26, 28, 30, 0.12)",
      }}
    >
      <Typography variant="body2" sx={{ fontWeight: 700 }}>
        {point.inventoryName}
      </Typography>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
        {formatStamp(point.savedAt, true)}
      </Typography>
      <Typography variant="body2">Utilidad bruta: {money(point.grossProfit)}</Typography>
      <Typography variant="body2">Ganancia neta: {money(point.investorNet)}</Typography>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
        {point.current && Math.abs(point.investorNet - point.indicatorsNet) < 0.01
          ? "Coincide con la ganancia neta de los indicadores y de Venta y ganancias."
          : point.current
            ? `Cálculo actual de este inventario. Los indicadores suman ${money(point.indicatorsNet)}.`
            : "Guardado anterior. Los indicadores usan el cálculo actual."}
      </Typography>
    </Box>
  );
}

function KpiGroup({
  title,
  help,
  columns,
  children,
}: {
  title: string;
  help: string;
  columns: Record<string, string>;
  children: ReactNode;
}) {
  return (
    <Box sx={{ display: "grid", gap: 1.25 }}>
      <ChartTitle title={title} help={help} />
      <Box sx={{ display: "grid", gap: { xs: 0, md: 1.5 }, gridTemplateColumns: columns, border: { xs: "1px solid rgba(26, 28, 30, 0.08)", md: "none" }, borderRadius: { xs: "14px", md: 0 }, overflow: "hidden", bgcolor: { xs: "#FFFFFF", md: "transparent" }, "& > :last-child:nth-child(odd)": { gridColumn: { xs: "1 / -1", md: "auto" } } }}>{children}</Box>
    </Box>
  );
}

function StackedCosts({
  items,
}: {
  items: { name: string; value: number; color: string }[];
}) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const barTotal = items.reduce((sum, item) => sum + Math.max(item.value, 0), 0);
  return (
    <Box sx={{ mt: 2 }}>
      <Box
        sx={{
          display: "flex",
          gap: barTotal > 0 ? "3px" : 0,
          height: 14,
          borderRadius: 999,
          overflow: "hidden",
          bgcolor: barTotal > 0 ? "#FFFFFF" : COLORS.track,
        }}
      >
        {items.map((item) =>
          barTotal > 0 && item.value > 0 ? (
            <Box
              key={item.name}
              sx={{ width: `${(item.value / barTotal) * 100}%`, bgcolor: item.color }}
            />
          ) : null,
        )}
      </Box>
      <Box sx={{ display: "grid", gap: 1.25, mt: 2 }}>
        {items.map((item) => {
          const share = total > 0 ? (item.value / total) * 100 : 0;
          return (
            <Box key={item.name} sx={{ display: "flex", justifyContent: "space-between", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>
                <Box sx={{ width: 10, height: 10, borderRadius: "50%", bgcolor: item.color, flexShrink: 0 }} />
                <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                  {item.name}
                </Typography>
              </Box>
              <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: "anywhere" }}>
                {money(item.value)} · {shareText(share)}
              </Typography>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function inventoryLabel(item: PricingInventory, items: PricingInventory[]): string {
  const duplicated = items.filter((other) => other.name.trim() === item.name.trim()).length > 1;
  return duplicated ? `${item.name} · ${item.id.slice(0, 6)}` : item.name;
}

export default function ProfitabilityDashboard({
  inventories,
}: {
  inventories: PricingInventory[];
}) {
  const [filters, setFilters] = useState<ProfitabilityFilters>(EMPTY_PROFITABILITY_FILTERS);
  const unique = useMemo(() => uniqueInventories(inventories), [inventories]);
  const invoices = useMemo(
    () => invoiceOptions(inventories, filters),
    [inventories, filters],
  );
  const invoice = invoices.includes(filters.invoice) ? filters.invoice : "";
  const report = useMemo(
    () => buildProfitability(inventories, { ...filters, invoice }),
    [inventories, filters, invoice],
  );
  const patch = (partial: Partial<ProfitabilityFilters>) => setFilters((current) => ({ ...current, ...partial }));
  const investment = report.purchaseSubtotal + report.logisticsCost;
  const costColors = [COLORS.compra, COLORS.logistica, COLORS.comision];
  const compareColors = [COLORS.venta, COLORS.bruta, COLORS.neta];
  const compareMax = Math.max(...report.comparison.map((item) => item.value), 0);
  const costItems = report.costs.map((item, index) => ({
    name: item.name === "Comisión del vendedor" ? "Comisión" : item.name,
    value: item.value,
    color: costColors[index] ?? COLORS.comision,
  }));
  const currentByInventory = useMemo(() => {
    const map = new Map<string, { grossProfit: number; investorNet: number; latestSavedAt: number | null }>();
    scopeInventories(inventories, filters).forEach((item) => {
      const totals = computeInventory(item).totals;
      let latestSavedAt: number | null = null;
      item.history.forEach((entry) => {
        const time = new Date(entry.savedAt).getTime();
        if (Number.isNaN(time)) return;
        if (latestSavedAt == null || time > latestSavedAt) latestSavedAt = time;
      });
      map.set(item.id, {
        grossProfit: totals.grossProfit,
        investorNet: totals.investorNet,
        latestSavedAt,
      });
    });
    return map;
  }, [inventories, filters]);
  const series = useMemo(
    () => evolutionSeries(report.evolution, currentByInventory, report.investorNet),
    [report.evolution, currentByInventory, report.investorNet],
  );
  const evolutionPoints = series.reduce((count, item) => count + item.points.length, 0);
  const singleSeries = series.length === 1 ? series[0] : null;
  const onlyPoint = evolutionPoints === 1 ? series[0]?.points[0] : undefined;
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <Box sx={{ display: "grid", gap: { xs: 1.25, md: 2 } }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", gap: 2, alignItems: "center", flexWrap: "wrap" }}>
        <Box>
          <Typography variant="h5">Dashboard de rentabilidad</Typography>
          <Typography variant="body2" color="text.secondary">
            Indicadores actuales de los inventarios guardados. Cada inventario usa su método 2 o 3.
          </Typography>
        </Box>
        <Card
          component="button"
          onClick={() => navigate(location.pathname.replace(/\/pricingSystem\/[^/]+$/, "/pricingSystem/ventas-comisiones"))}
          sx={{ px: 1.5, py: 1, textAlign: "left", cursor: "pointer", borderRadius: "12px", bgcolor: "#E8F0FE", color: "#1A56DB", boxShadow: "none", width: { xs: "100%", sm: "auto" } }}
        >
          <Typography sx={{ fontWeight: 800, color: "#1A56DB" }}>Ventas y Comisiones</Typography>
          <Typography variant="caption" sx={{ color: "#1A56DB" }}>Paquetes vendidos y ganancias reales</Typography>
        </Card>
      </Box>

      <Card>
        <CardContent sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "1fr 1fr", [upDesktop]: "repeat(4, 1fr)" } }}>
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
          <TextField
            select
            label="Factura"
            value={invoice}
            onChange={(event) => patch({ invoice: event.target.value })}
          >
            <MenuItem value="">Todas</MenuItem>
            {invoices.map((code) => (
              <MenuItem key={code} value={code}>
                {code}
              </MenuItem>
            ))}
          </TextField>
        </CardContent>
      </Card>

      <Alert severity="info">
        Los indicadores usan el cálculo actual del motor. La evolución usa los guardados del historial y puede diferir si el inventario cambió después de guardarse.
        {filters.invoice
          ? " Con una factura seleccionada, la logística es solo la parte ya asignada a sus productos."
          : ""}
      </Alert>

      {!scopeInventories(inventories, filters).length ? (
        <Alert severity="warning">No hay inventarios en este filtro.</Alert>
      ) : null}

      <KpiGroup
        title="Volumen de operación"
        help="Cuánto se está moviendo: inventarios, productos, paquetes y el dinero invertido en compras."
        columns={{ xs: "1fr 1fr", [upDesktop]: "repeat(4, 1fr)" }}
      >
        <Kpi label="Inventarios" value={qty(report.inventoryCount)} help="Cantidad de inventarios del filtro. Un mismo documento no se cuenta dos veces." />
        <Kpi label="Productos" value={qty(report.productCount)} help="Productos incluidos en el cálculo actual de esos inventarios." />
        <Kpi label="Paquetes" value={qty(report.packages)} help="Suma de los paquetes de los productos incluidos." />
        <Kpi label="Inversión en compras" value={money(report.purchaseSubtotal)} help="Suma del costo de compra de los productos incluidos." />
      </KpiGroup>

      <KpiGroup
        title="Resultado comercial"
        help="Lo que se proyecta vender, la utilidad antes de repartir y el rendimiento sobre la inversión."
        columns={{ xs: "1fr 1fr", [upDesktop]: "repeat(4, 1fr)" }}
      >
        <Kpi label="Venta proyectada" value={money(report.projectedSales)} help="Suma de la venta proyectada con el precio aplicado de cada producto." />
        <Kpi label="Utilidad bruta" value={money(report.grossProfit)} help="Venta proyectada menos el costo de compra, antes de comisión y logística." />
        <Kpi
          label="Margen ponderado"
          value={percent(report.weightedMarginPercent)}
          hint="Ponderado según el volumen de ventas"
          help="Es la utilidad bruta total dividida entre la venta total. No es el promedio simple de los márgenes de cada producto."
        />
        <Kpi
          label="ROI"
          value={percent(report.roiPercent)}
          hint={
            <Box sx={{ display: "grid" }}>
              <span>Ganancia neta: {money(report.investorNet)}</span>
              <span>Inversión: {money(investment)}</span>
            </Box>
          }
          help="Ganancia neta del inversionista dividida entre la compra más la logística."
        />
      </KpiGroup>

      <KpiGroup
        title="Distribución de ganancias"
        help="En qué se reparte la operación: logística, comisión del vendedor y lo que queda para el inversionista."
        columns={{ xs: "1fr 1fr", [upDesktop]: "repeat(3, 1fr)" }}
      >
        <Kpi label="Gastos logísticos" value={money(report.logisticsCost)} help="Gasto logístico del inventario. Si filtras por factura, es solo la parte que el motor ya asignó a esos productos." />
        <Kpi label="Comisión del vendedor" value={money(report.vendorProfit)} help="Comisión del vendedor. Cada inventario usa su método 2 o 3 y el porcentaje general o el del producto." />
        <Kpi label="Ganancia neta del inversionista" value={money(report.investorNet)} hint="Cálculo actual" help="Lo que queda para el inversionista después de la comisión y la logística, según el método de cada inventario." />
      </KpiGroup>

      <Box sx={{ display: "grid", gap: { xs: 1.25, md: 2 }, gridTemplateColumns: { xs: "1fr", [upDesktop]: "1fr 1fr" } }}>
        <Card>
          <CardContent>
            <ChartTitle
              title="Distribución de costos"
              help="Una sola barra apilada con compra, logística y comisión del cálculo actual. El largo de cada tramo es su parte del total, y la leyenda muestra el importe y el porcentaje."
            />
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Compra, logística y comisión, con importe y porcentaje.
            </Typography>
            <StackedCosts items={costItems} />
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <ChartTitle
              title="Venta y ganancias"
              help="Los tres importes son los mismos de los indicadores de arriba: venta proyectada, utilidad bruta y ganancia neta del inversionista."
            />
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Barras con el importe visible junto a cada concepto.
            </Typography>
            <Box sx={{ display: "grid", gap: 1.75, mt: 2 }}>
              {report.comparison.map((item, index) => (
                <MeterRow
                  key={item.name}
                  label={item.name === "Ganancia neta del inversionista" ? "Ganancia neta" : item.name}
                  amount={money(item.value)}
                  width={compareMax > 0 ? (Math.max(item.value, 0) / compareMax) * 100 : 0}
                  color={compareColors[index]}
                />
              ))}
            </Box>
          </CardContent>
        </Card>
      </Box>

      <Card>
        <CardContent>
          <ChartTitle
            title="Evolución de ganancias"
            help="Cada punto es un guardado real, con su fecha y hora. El último punto de cada inventario usa el mismo cálculo actual que la ganancia neta de los indicadores. Los puntos anteriores conservan el valor guardado en ese momento."
          />
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 1.5 }}>
            {report.historyAvailable
              ? "El último punto usa la misma ganancia neta que los indicadores. Los puntos anteriores son el valor guardado en ese momento."
              : "El historial se guardó por inventario completo. Elige todas las facturas para ver este gráfico."}
          </Typography>
          {report.historyAvailable && evolutionPoints === 0 ? (
            <Alert severity="info">Todavía no hay guardados en este periodo.</Alert>
          ) : null}
          {report.historyAvailable && evolutionPoints === 1 ? (
            <Alert severity="info">
              Todavía no hay suficientes datos para observar una tendencia. Hay un solo registro
              {onlyPoint
                ? `: ${onlyPoint.inventoryName}, ${formatStamp(onlyPoint.savedAt, true)}, utilidad bruta ${money(onlyPoint.grossProfit)} y ganancia neta ${money(onlyPoint.investorNet)}.`
                : "."}
            </Alert>
          ) : null}
          {report.historyAvailable && evolutionPoints > 1 ? (
            <Box>
              <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1.5, mb: 1 }}>
                {singleSeries ? (
                  <>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
                      <Box sx={{ width: 18, height: 3, borderRadius: 999, bgcolor: COLORS.bruta }} />
                      <Typography variant="body2">Utilidad bruta</Typography>
                    </Box>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
                      <Box sx={{ width: 18, height: 3, borderRadius: 999, bgcolor: COLORS.neta }} />
                      <Typography variant="body2">Ganancia neta</Typography>
                    </Box>
                  </>
                ) : (
                  series.map((item) => (
                    <Box key={item.id} sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
                      <Box sx={{ width: 10, height: 10, borderRadius: "50%", bgcolor: item.color }} />
                      <Typography variant="body2">{item.name}</Typography>
                    </Box>
                  ))
                )}
              </Box>
              {!singleSeries ? (
                <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1 }}>
                  Línea continua: utilidad bruta. Línea punteada: ganancia neta.
                </Typography>
              ) : null}
              <Box sx={{ width: "100%", height: { xs: 188, sm: 300 }, minWidth: 0 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={series.flatMap((item) => item.points)} margin={{ top: 12, right: 8, left: 0, bottom: 8 }}>
                    <CartesianGrid stroke={COLORS.track} vertical={false} />
                    <XAxis
                      dataKey="savedAt"
                      type="number"
                      domain={["dataMin", "dataMax"]}
                      scale="time"
                      tickFormatter={(value) => formatStamp(Number(value))}
                      minTickGap={28}
                      height={52}
                      tick={{ fill: "#5F6368", fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      domain={profitDomain(series)}
                      tickFormatter={(value) => axisMoney(Number(value))}
                      tick={{ fill: "#5F6368", fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      width={52}
                    />
                    <ChartTooltip content={<EvolutionTip />} />
                    {singleSeries ? (
                      <Area
                        data={singleSeries.points}
                        type="linear"
                        dataKey="grossProfit"
                        stroke="none"
                        fill={COLORS.bruta}
                        fillOpacity={0.12}
                        isAnimationActive={false}
                      />
                    ) : null}
                    {series.map((item) => (
                      <Line
                        key={`${item.id}-gross`}
                        data={item.points}
                        type="linear"
                        dataKey="grossProfit"
                        name={`${item.name} · Utilidad bruta`}
                        stroke={singleSeries ? COLORS.bruta : item.color}
                        strokeWidth={2.5}
                        dot={{ r: 4, fill: singleSeries ? COLORS.bruta : item.color, strokeWidth: 0 }}
                        isAnimationActive={false}
                      />
                    ))}
                    {series.map((item) => (
                      <Line
                        key={`${item.id}-net`}
                        data={item.points}
                        type="linear"
                        dataKey="investorNet"
                        name={`${item.name} · Ganancia neta`}
                        stroke={singleSeries ? COLORS.neta : item.color}
                        strokeDasharray={singleSeries ? undefined : "5 4"}
                        strokeWidth={2.5}
                        dot={{ r: 4, fill: singleSeries ? COLORS.neta : item.color, strokeWidth: 0 }}
                        isAnimationActive={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </Box>
            </Box>
          ) : null}
        </CardContent>
      </Card>
    </Box>
  );
}
