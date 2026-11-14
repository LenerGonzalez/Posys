import { useEffect, useMemo, useState, type ReactNode } from "react";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../firebase";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Collapse,
  IconButton,
  MenuItem,
  TextField,
  Typography,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { listCommissionActivity } from "./firestorePayments";
import { listPricingSales, voidSale } from "./firestoreSales";
import { dateTimeLabel, money, qty } from "./format";
import { saleProducts } from "./saleCommit";
import {
  buildSalesDashboard,
  EMPTY_DASHBOARD_FILTERS,
  type DashboardFilters,
  type SalesDashboardReport,
} from "./dashboardReport";
import type { CommissionBalance, CommissionPayment } from "./commissionCommit";
import type { PricingSale } from "./saleCommit";
import DashboardProductSection from "./DashboardProductSection";
import { canVoidSale, rolesFromProfile } from "./saleVoid";
import { upDesktop } from "./screen";
import type { PricingInventory } from "./types";

function axisMoney(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000) return `C$ ${(value / 1000).toLocaleString("es-NI", { maximumFractionDigits: 1 })}k`;
  return money(value, abs >= 100 ? 0 : 2);
}

function Metric({ label, value, caption, background, color }: { label: string; value: string; caption?: string; background: string; color: string }) {
  return (
    <Box sx={{ minWidth: 0, px: { xs: 1, md: 1.5 }, py: { xs: 0.85, md: 1.35 }, borderRadius: "12px", bgcolor: background }}>
      <Typography variant="caption" sx={{ color, display: "block", lineHeight: 1.2 }}>{label}</Typography>
      <Typography sx={{ fontWeight: 800, color, fontSize: { xs: "1.05rem", sm: "1.4rem" }, lineHeight: 1.15, overflowWrap: "anywhere" }}>{value}</Typography>
      {caption ? <Typography variant="caption" sx={{ color, display: "block" }}>{caption}</Typography> : null}
    </Box>
  );
}

function ChartCard({ title, children, summary }: { title: string; children: ReactNode; summary: string }) {
  return (
    <Card variant="outlined" sx={{ boxShadow: "0 1px 2px rgba(26, 28, 30, 0.04)" }}>
      <CardContent sx={{ display: "grid", gap: 1 }}>
        <Typography sx={{ fontWeight: 800 }}>{title}</Typography>
        <Typography variant="body2" color="text.secondary">{summary}</Typography>
        {children}
      </CardContent>
    </Card>
  );
}

function Bars({
  data,
  dataKey,
  color,
  asMoney,
}: {
  data: ReadonlyArray<{ label: string; [key: string]: string | number }>;
  dataKey: string;
  color: string;
  asMoney: boolean;
}) {
  if (!data.length) return <Typography variant="body2" color="text.secondary">Sin datos en este filtro.</Typography>;
  return (
    <Box sx={{ width: "100%", height: { xs: 168, md: 220 }, minWidth: 0 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 28, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#E8EAED" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#44474E" }} interval="preserveStartEnd" minTickGap={12} />
          <YAxis width={48} tick={{ fontSize: 10, fill: "#44474E" }} tickFormatter={(value) => asMoney ? axisMoney(Number(value)) : qty(Number(value))} />
          <Bar dataKey={dataKey} fill={color} radius={[6, 6, 0, 0]} maxBarSize={56}>
            <LabelList
              dataKey={dataKey}
              position="top"
              formatter={(value) => asMoney ? money(Number(value)) : qty(Number(value))}
              style={{ fontSize: 10, fill: "#1A1C1E" }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </Box>
  );
}

export default function SalesDashboard({ inventories }: { inventories: PricingInventory[] }) {
  const [sales, setSales] = useState<PricingSale[]>([]);
  const [balances, setBalances] = useState<CommissionBalance[]>([]);
  const [payments, setPayments] = useState<CommissionPayment[]>([]);
  const [filters, setFilters] = useState<DashboardFilters>(EMPTY_DASHBOARD_FILTERS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openSales, setOpenSales] = useState<Record<string, boolean>>({});
  const [openPayments, setOpenPayments] = useState<Record<string, boolean>>({});
  const [actorUid, setActorUid] = useState("");
  const [actorRoles, setActorRoles] = useState<string[]>([]);
  const [voiding, setVoiding] = useState(false);
  const [notice, setNotice] = useState("");

  const loadReport = () => {
    const user = auth.currentUser;
    setActorUid(user?.uid || "");
    return Promise.all([
      listPricingSales(),
      listCommissionActivity(),
      user ? getDoc(doc(db, "users", user.uid)) : Promise.resolve(null),
    ]).then(([listedSales, activity, profile]) => {
      setSales(listedSales);
      setBalances(activity.balances);
      setPayments(activity.payments);
      setActorRoles(profile?.exists() ? rolesFromProfile(profile.data() as Record<string, unknown>) : []);
    });
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void loadReport()
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "No se pudo consultar el dashboard.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const catalog = useMemo(
    () => saleProducts(inventories).map((product) => ({
      inventoryId: product.inventoryId,
      inventoryName: product.inventoryName,
      productId: product.productId,
      productName: product.productName,
      invoiceNumber: product.invoiceNumber,
      initialPackages: product.initialPackages,
    })),
    [inventories],
  );
  const report: SalesDashboardReport = useMemo(
    () => buildSalesDashboard(sales, balances, payments, catalog, filters),
    [sales, balances, payments, catalog, filters],
  );
  const inventoryOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const product of catalog) options.set(product.inventoryId, product.inventoryName);
    for (const sale of sales) {
      if (sale.status === "ANULADA") continue;
      for (const line of sale.lines) options.set(line.inventoryId, line.inventoryName.trim() || options.get(line.inventoryId) || "Inventario");
    }
    return [...options.entries()].map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name, "es"));
  }, [catalog, sales]);
  const productOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const product of catalog) {
      if (filters.inventoryId && product.inventoryId !== filters.inventoryId) continue;
      options.set(product.productId, product.productName);
    }
    for (const sale of sales) {
      if (sale.status === "ANULADA") continue;
      for (const line of sale.lines) {
        if (filters.inventoryId && line.inventoryId !== filters.inventoryId) continue;
        options.set(line.productId, line.productName);
      }
    }
    return [...options.entries()].map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name, "es"));
  }, [catalog, sales, filters.inventoryId]);

  const patch = (next: Partial<DashboardFilters>) => setFilters((current) => ({ ...current, ...next }));
  const requestVoid = (operationId: string, sellerName: string, salesTotal: number) => {
    if (voiding) return;
    const accepted = window.confirm(
      `¿Anular esta venta de ${sellerName} por ${money(salesTotal)}?\n\nSe devuelven los paquetes al inventario y la venta deja de aparecer en el historial y en los totales.`,
    );
    if (!accepted) return;
    setVoiding(true);
    setError("");
    setNotice("");
    void voidSale(operationId)
      .then(() => loadReport())
      .then(() => setNotice("La venta se anuló. Los paquetes volvieron al inventario."))
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "No se pudo anular la venta.");
      })
      .finally(() => setVoiding(false));
  };

  return (
    <Box sx={{ display: "grid", gap: { xs: 1.25, md: 2 } }}>
      <Box>
        <Typography variant="h5">Ventas y Comisiones</Typography>
        <Typography variant="body2" color="text.secondary">
          Resultados de los paquetes vendidos. Las ventas proyectadas del inventario no se cuentan como ventas realizadas.
        </Typography>
      </Box>
      {notice ? <Alert severity="success" onClose={() => setNotice("")}>{notice}</Alert> : null}
      {error ? (
        <Alert severity="error">{error}</Alert>
      ) : null}

      <Card variant="outlined" sx={{ boxShadow: "0 1px 2px rgba(26, 28, 30, 0.04)" }}>
        <CardContent sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "1fr 1fr", [upDesktop]: "repeat(4, 1fr)" } }}>
          <TextField label="Desde" type="date" value={filters.from} onChange={(event) => patch({ from: event.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
          <TextField label="Hasta" type="date" value={filters.to} onChange={(event) => patch({ to: event.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
          <TextField select label="Inventario" value={filters.inventoryId} onChange={(event) => patch({ inventoryId: event.target.value, productId: "" })}>
            <MenuItem value="">Todos</MenuItem>
            {inventoryOptions.map((item) => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}
          </TextField>
          <TextField select label="Producto" value={filters.productId} onChange={(event) => patch({ productId: event.target.value })}>
            <MenuItem value="">Todos</MenuItem>
            {productOptions.map((item) => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}
          </TextField>
        </CardContent>
      </Card>

      <Box>
        <Typography sx={{ fontWeight: 800, mb: 1 }}>Actividad de ventas</Typography>
        <Box sx={{ display: "grid", gap: 0.75, gridTemplateColumns: { xs: "1fr 1fr", md: "1fr 1fr 1fr" } }}>
          <Metric label="Paquetes vendidos" value={loading ? "—" : qty(report.packagesSold)} caption="Según la fecha de la venta" background="#E8F0FE" color="#1A56DB" />
          <Metric label="Stock disponible actual" value={loading || report.packagesAvailable == null ? "—" : qty(report.packagesAvailable)} caption="Incluye productos sin ventas" background="#E7EDF4" color="#3A4654" />
          <Box sx={{ gridColumn: { xs: "1 / -1", md: "auto" } }}>
            <Metric label="Total de ventas" value={loading ? "—" : money(report.salesTotal)} caption="Ventas dentro del período" background="#E6F4EA" color="#0D652D" />
          </Box>
        </Box>
      </Box>
      <Box>
        <Typography sx={{ fontWeight: 800, mb: 1 }}>Ganancias del inversionista</Typography>
        <Box sx={{ display: "grid", gap: 0.75, gridTemplateColumns: "1fr 1fr" }}>
          <Metric label="Ganancia neta generada" value={loading ? "—" : money(report.investorNet)} caption="De las ventas del período" background="#FFF7F0" color="#C05A12" />
          <Metric label="Ganancia neta por paquete" value={loading || report.investorPerPackage == null ? "—" : money(report.investorPerPackage)} caption="Sobre los paquetes vendidos" background="#FFF7F0" color="#C05A12" />
        </Box>
      </Box>
      <Box>
        <Typography sx={{ fontWeight: 800, mb: 1 }}>Ganancias del vendedor</Typography>
        <Box sx={{ display: "grid", gap: 0.75, gridTemplateColumns: { xs: "1fr 1fr", md: "1fr 1fr 1fr" } }}>
          <Metric label="Comisión generada" value={loading ? "—" : money(report.commissionGenerated)} caption="Según la fecha de la venta" background="#E7EDF4" color="#3A4654" />
          <Metric label="Comisión pagada" value={loading ? "—" : money(report.commissionPaid)} caption="Saldo actual de esas ventas" background="#E8F0FE" color="#1A56DB" />
          <Box sx={{ gridColumn: { xs: "1 / -1", md: "auto" } }}>
            <Metric label="Comisión pendiente" value={loading ? "—" : money(report.commissionPending)} caption="Saldo actual de esas ventas" background="#F7F4FC" color="#6D4BA1" />
          </Box>
        </Box>
        {report.historicalRoundingCents === 1 ? (
          <Typography variant="body2" sx={{ mt: 1, color: "#8D4E00" }}>
            Incluye un ajuste histórico de redondeo de {money(0.01)}. No es un pago nuevo y los pagos registrados conservan sus aplicaciones.
          </Typography>
        ) : null}
      </Box>

      <Box>
        <ChartCard title="Comisiones pagadas y pendientes" summary={loading ? "Consultando…" : `${money(report.commissionPaid)} pagadas · ${money(report.commissionPending)} pendientes`}>
          <Bars
            data={[
              { label: "Pagada", value: report.commissionPaid },
              { label: "Pendiente", value: report.commissionPending },
            ]}
            dataKey="value"
            color="#1A56DB"
            asMoney
          />
        </ChartCard>
      </Box>

      <Box sx={{ display: "grid", gap: 1 }}>
        <Typography sx={{ fontWeight: 800 }}>Por inventario y producto</Typography>
        <Typography variant="body2" color="text.secondary">
          Ventas, ganancias y comisiones siguen la fecha de la venta. Disponibles es el stock actual: iniciales menos lo vendido acumulado.
        </Typography>
        {!loading && !report.products.length ? (
          <Typography variant="body2" color="text.secondary">No hay productos en este filtro.</Typography>
        ) : (
          <DashboardProductSection rows={report.products} />
        )}
      </Box>

      <Box sx={{ display: "grid", gap: 1 }}>
        <Typography sx={{ fontWeight: 800 }}>Historial de ventas</Typography>
        <Typography variant="body2" color="text.secondary">Usa la fecha de la venta, no la fecha del pago.</Typography>
        {report.sales.map((sale) => {
          const open = Boolean(openSales[sale.operationId]);
          return (
            <Card key={sale.operationId} variant="outlined" sx={{ boxShadow: "0 1px 2px rgba(26, 28, 30, 0.04)" }}>
              <CardContent sx={{ display: "grid", gap: 1 }}>
                <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography sx={{ fontWeight: 700 }}>{sale.sellerName}</Typography>
                    <Typography variant="body2" color="text.secondary">{dateTimeLabel(sale.soldAt)} · {sale.status}</Typography>
                  </Box>
                  <Box sx={{ textAlign: "right" }}>
                    <Typography sx={{ fontWeight: 800 }}>{money(sale.salesTotal)}</Typography>
                    <Typography variant="caption" color="text.secondary">{qty(sale.packageCount)} {sale.packageCount === 1 ? "paquete" : "paquetes"}</Typography>
                  </Box>
                  <IconButton aria-label={open ? "Ocultar líneas" : "Ver líneas"} aria-expanded={open} onClick={() => setOpenSales((current) => ({ ...current, [sale.operationId]: !open }))}>
                    <ExpandMoreIcon sx={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 160ms ease" }} />
                  </IconButton>
                </Box>
                {canVoidSale(actorUid, actorRoles, sale.sellerUid) ? (
                  <Button
                    variant="text"
                    color="error"
                    disabled={voiding}
                    onClick={() => requestVoid(sale.operationId, sale.sellerName, sale.salesTotal)}
                    sx={{ justifyContent: "flex-start", px: 0, minHeight: 36, fontWeight: 700 }}
                  >
                    Anular venta
                  </Button>
                ) : null}
                <Collapse in={open}>
                  <Box sx={{ display: "grid", gap: 1 }}>
                    {sale.lines.map((line, index) => (
                      <Box key={`${sale.operationId}-${index}`} sx={{ display: "grid", gap: 0.25, p: 1.25, borderRadius: "12px", bgcolor: "#F8F9FB" }}>
                        <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1 }}>
                          <Typography sx={{ fontWeight: 700 }}>{line.productName}</Typography>
                          <Typography sx={{ fontWeight: 800 }}>{money(line.salesTotal)}</Typography>
                        </Box>
                        <Typography variant="body2" color="text.secondary">
                          {line.inventoryName} · Factura {line.invoiceNumber || "sin número"} · {qty(line.quantity)} {line.quantity === 1 ? "paquete" : "paquetes"} · {line.status}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          Inversionista {money(line.investorNet)} · Comisión {money(line.vendorProfit)}
                        </Typography>
                      </Box>
                    ))}
                    <Typography variant="body2" color="text.secondary">
                      Total de la operación {money(sale.operationSalesTotal)} · {qty(sale.operationPackageCount)} {sale.operationPackageCount === 1 ? "paquete" : "paquetes"}
                      {sale.linesOutsideFilter ? " · Hay líneas fuera de este filtro." : ""}
                    </Typography>
                  </Box>
                </Collapse>
              </CardContent>
            </Card>
          );
        })}
        {!loading && !report.sales.length ? <Typography variant="body2" color="text.secondary">No hay ventas en este filtro.</Typography> : null}
      </Box>

      <Box sx={{ display: "grid", gap: 1 }}>
        <Typography sx={{ fontWeight: 800 }}>Historial de pagos</Typography>
        <Typography variant="body2" color="text.secondary">Usa la fecha real del pago. El saldo pendiente de arriba es el de las ventas del período.</Typography>
        {report.payments.map((payment) => {
          const open = Boolean(openPayments[payment.operationId]);
          return (
            <Card key={payment.operationId} variant="outlined" sx={{ boxShadow: "0 1px 2px rgba(26, 28, 30, 0.04)" }}>
              <CardContent sx={{ display: "grid", gap: 1 }}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography sx={{ fontWeight: 700 }}>{payment.sellerName}</Typography>
                    <Typography variant="body2" color="text.secondary">{dateTimeLabel(payment.paidAt)}</Typography>
                  </Box>
                  <Typography sx={{ fontWeight: 800, color: "#0D652D" }}>{money(payment.amount)}</Typography>
                  <IconButton aria-label={open ? "Ocultar aplicaciones" : "Ver aplicaciones"} aria-expanded={open} onClick={() => setOpenPayments((current) => ({ ...current, [payment.operationId]: !open }))}>
                    <ExpandMoreIcon sx={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 160ms ease" }} />
                  </IconButton>
                </Box>
                <Collapse in={open}>
                  <Box sx={{ display: "grid", gap: 1 }}>
                    {payment.applications.map((line, index) => (
                      <Box key={`${payment.operationId}-${line.saleId}-${index}`} sx={{ p: 1.25, borderRadius: "12px", bgcolor: "#F8F9FB" }}>
                        <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1 }}>
                          <Typography sx={{ fontWeight: 700 }}>{line.productName}</Typography>
                          <Typography sx={{ fontWeight: 800 }}>{money(line.amount)}</Typography>
                        </Box>
                        <Typography variant="body2" color="text.secondary">
                          {line.inventoryName} · Factura {line.invoiceNumber || "sin número"} · Quedó pendiente {money(line.pendingAfter)}
                        </Typography>
                      </Box>
                    ))}
                    {payment.applicationsOutsideFilter ? (
                      <Typography variant="body2" color="text.secondary">Este pago tiene más aplicaciones fuera del filtro. El monto mostrado es el pago registrado.</Typography>
                    ) : null}
                  </Box>
                </Collapse>
              </CardContent>
            </Card>
          );
        })}
        {!loading && !report.payments.length ? <Typography variant="body2" color="text.secondary">No hay pagos en este filtro.</Typography> : null}
      </Box>

    </Box>
  );
}
