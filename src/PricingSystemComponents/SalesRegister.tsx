import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { v4 as uuid } from "uuid";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  IconButton,
  MenuItem,
  TextField,
  Typography,
} from "@mui/material";
import AccountBalanceWalletOutlinedIcon from "@mui/icons-material/AccountBalanceWalletOutlined";
import AddIcon from "@mui/icons-material/Add";
import CheckCircleOutlinedIcon from "@mui/icons-material/CheckCircleOutlined";
import CalendarTodayOutlinedIcon from "@mui/icons-material/CalendarTodayOutlined";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import PersonOutlineOutlinedIcon from "@mui/icons-material/PersonOutlineOutlined";
import PrintOutlinedIcon from "@mui/icons-material/PrintOutlined";
import ReceiptLongOutlinedIcon from "@mui/icons-material/ReceiptLongOutlined";
import ShoppingBagOutlinedIcon from "@mui/icons-material/ShoppingBagOutlined";
import ShowChartOutlinedIcon from "@mui/icons-material/ShowChartOutlined";
import { readSellerName, readSoldPackages, registerSale } from "./firestoreSales";
import { dateTimeLabel, money, percent, qty } from "./format";
import NumericField from "./NumericField";
import {
  availablePackages,
  reviewSale,
  saleProducts,
  stockKey,
  type DraftSaleLine,
  type PricingSale,
  type ReviewedSaleLine,
  type SaleProduct,
} from "./saleCommit";
import { downloadSaleVoucher, printSaleVoucher, vendorCommissionNote, voucherAfterAttempt, voucherPrice } from "./saleVoucher";
import { dialogActionsSx, useNarrowScreen } from "./screen";
import { commissionMethodLabel, type PricingInventory } from "./types";

function availabilityTone(count: number | null): { background: string; color: string } {
  if (count == null) return { background: "#F4F6F8", color: "#5C6370" };
  if (count > 0) return { background: "#E6F4EA", color: "#0D652D" };
  return { background: "#FCE8E6", color: "#A50E0E" };
}

function availabilityLabel(count: number | null): string {
  if (count == null) return "Consultando";
  return `${qty(count)} ${count === 1 ? "paquete disponible" : "paquetes disponibles"}`;
}

function AvailabilityBadge({ count }: { count: number | null }) {
  const tone = availabilityTone(count);
  return (
    <Box sx={{ flexShrink: 0, px: 1, py: 0.35, borderRadius: "999px", bgcolor: tone.background }}>
      <Typography variant="caption" sx={{ fontWeight: 700, color: tone.color, whiteSpace: "nowrap" }}>
        {availabilityLabel(count)}
      </Typography>
    </Box>
  );
}

interface DraftLine extends DraftSaleLine {
  id: string;
}

function registrationError(message: string): string {
  const clean = message.trim();
  if (!clean) return "No se pudo registrar la venta.";
  const lower = clean.toLowerCase();
  if (lower.includes("no se pudo registrar") || lower.includes("no se registró")) return clean;
  return `No se pudo registrar la venta. ${clean}`;
}

function priceLabel(value: number): string {
  return money(value, Number.isInteger(value) ? 0 : 2);
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.2 }}>
        {label}
      </Typography>
      <Typography sx={{ fontWeight: 700, overflowWrap: "anywhere" }}>{value}</Typography>
    </Box>
  );
}

function Notice({
  tone,
  children,
  action,
}: {
  tone: "warning" | "error" | "success";
  children: string;
  action?: ReactNode;
}) {
  const palette = {
    warning: { background: "#FEF4D6", color: "#8D4E00" },
    error: { background: "#FCE8E6", color: "#A50E0E" },
    success: { background: "#E6F4EA", color: "#0D652D" },
  }[tone];
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", px: 1.25, py: 0.75, borderRadius: 2, bgcolor: palette.background }}>
      <Typography sx={{ flex: "1 1 180px", color: palette.color, fontSize: "0.8125rem", lineHeight: 1.35 }}>{children}</Typography>
      {action}
    </Box>
  );
}

function SummaryMetric({
  icon,
  label,
  value,
  background,
  color,
  emphasis,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  background: string;
  color: string;
  emphasis?: boolean;
}) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: { xs: 0.75, md: 1.25 }, minWidth: 0, px: { xs: 1, md: 1.5 }, py: emphasis ? { xs: 0.85, md: 1.5 } : { xs: 0.75, md: 1.25 }, borderRadius: { xs: "10px", md: 3 }, bgcolor: background }}>
      <Box sx={{ color, display: "flex", flexShrink: 0 }}>{icon}</Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="caption" sx={{ color, display: "block", lineHeight: 1.2 }}>{label}</Typography>
        <Typography sx={{ fontWeight: 700, fontSize: emphasis ? { xs: "1.2rem", sm: "1.35rem" } : "1.05rem", lineHeight: 1.25, overflowWrap: "anywhere" }}>{value}</Typography>
      </Box>
    </Box>
  );
}

function LineCard({
  row,
  onQuantity,
  onRemove,
}: {
  row: ReviewedSaleLine;
  onQuantity: (value: number | null) => void;
  onRemove: () => void;
}) {
  const product = row.product;
  const availableLabel = row.available == null ? null : qty(row.available);
  const availableTone = row.available != null && row.available > 0 ? { background: "#E6F4EA", color: "#0D652D" } : { background: "#FEF4D6", color: "#8D4E00" };
  return (
    <Card variant="outlined" sx={{ boxShadow: "0 1px 2px rgba(26, 28, 30, 0.04)", borderColor: "rgba(26, 28, 30, 0.08)" }}>
      <CardContent sx={{ display: "grid", gap: { xs: 0.75, md: 1.75 }, p: { xs: 1.25, md: 2.25 } }}>
        <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
          <Box sx={{ width: 36, height: 36, borderRadius: "10px", bgcolor: "#E8F0FE", color: "#1A56DB", display: { xs: "none", md: "flex" }, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Inventory2OutlinedIcon fontSize="small" />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="h6" sx={{ fontSize: { xs: "0.98rem", md: "1.2rem" }, lineHeight: 1.2 }}>
              {product?.productName || "Producto no disponible"}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", overflowWrap: "anywhere" }}>
              {product ? `${product.inventoryName} · Factura ${product.invoiceNumber || "sin número"}` : "Selecciona el producto de nuevo."}
            </Typography>
          </Box>
          <IconButton size="small" aria-label="Quitar línea" onClick={onRemove}>
            <DeleteOutlinedIcon fontSize="small" />
          </IconButton>
        </Box>
        {product ? (
          <Box sx={{ display: "grid", gap: 0.75, gridTemplateColumns: { xs: "1fr 1fr", sm: "1fr 1fr 1fr", md: "repeat(5, 1fr)" }, p: { xs: 1, md: 1.5 }, borderRadius: "12px", bgcolor: "#F8F9FB" }}>
            <Fact label="Paquetes iniciales" value={qty(product.initialPackages)} />
            <Fact label="Vendidos antes" value={qty(row.soldPackages)} />
            <Fact label="Disponibles" value={availableLabel || "—"} />
            <Fact label="Precio de venta" value={priceLabel(product.appliedPrice)} />
            <Fact label="Método" value={product.commissionMethod === "3" ? "Opción 3" : "Opción 2"} />
            <Fact label="Comisión / paquete" value={money(product.vendorProfitPerPack)} />
            <Fact label="Inversionista / paquete" value={money(product.investorNetPerPack)} />
          </Box>
        ) : null}
        {product ? (
          <Typography variant="caption" color="text.secondary">
            {commissionMethodLabel(product.commissionMethod)} · Comisión aplicada {percent(product.vendorSharePercent, Number.isInteger(product.vendorSharePercent) ? 0 : 2)}
          </Typography>
        ) : null}
        <Box sx={{ display: "grid", gap: 0.75, p: { xs: 0, md: 1.75 }, borderRadius: { xs: 0, md: "12px" }, bgcolor: { xs: "transparent", md: "#F3F7FE" } }}>
          {availableLabel != null ? (
            <Box sx={{ display: { xs: "none", md: "flex" }, justifyContent: "flex-end" }}>
              <Box sx={{ px: 1.25, py: 0.4, borderRadius: 999, bgcolor: availableTone.background }}>
                <Typography variant="caption" sx={{ fontWeight: 700, color: availableTone.color }}>Disponibles: {availableLabel}</Typography>
              </Box>
            </Box>
          ) : null}
          <NumericField
            label="Paquetes de esta venta"
            kind="packages"
            value={row.quantity}
            maximum={row.available == null ? undefined : Math.max(0, row.available)}
            onCommit={onQuantity}
            sx={{
              "& .MuiInputBase-root": { bgcolor: "#FFFFFF", fontSize: { xs: "1.05rem", md: "1.15rem" } },
              "& .MuiFormHelperText-root.Mui-error": { color: "#A50E0E", mx: 0, mt: 0.75 },
            }}
          />
          {row.message ? <Notice tone="warning">{row.message}</Notice> : null}
        </Box>
        {row.financials && !row.message ? (
          <Box sx={{ display: "grid", gap: 0.75, gridTemplateColumns: { xs: "1fr 1fr", md: "repeat(3, 1fr)" } }}>
            <Fact label="Venta de la línea" value={money(row.financials.salesTotal)} />
            <Fact label="Utilidad bruta" value={money(row.financials.grossProfit)} />
            <Fact label="Ganancia del vendedor" value={money(row.financials.vendorProfit)} />
            <Fact label="Ganancia del inversionista" value={money(row.financials.investorNet)} />
            <Fact label="Disponibles después" value={row.availableAfter == null ? "—" : qty(row.availableAfter)} />
          </Box>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function SalesRegister({ inventories }: { inventories: PricingInventory[] }) {
  const [inventoryIds, setInventoryIds] = useState<string[]>([]);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [addId, setAddId] = useState("");
  const [sold, setSold] = useState<Record<string, number>>({});
  const [stockReady, setStockReady] = useState(false);
  const [sellerName, setSellerName] = useState("");
  const [operationId, setOperationId] = useState(() => uuid());
  const [confirming, setConfirming] = useState(false);
  const [previewAt, setPreviewAt] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState("");
  const [registeredId, setRegisteredId] = useState("");
  const [voucher, setVoucher] = useState<PricingSale | null>(null);
  const narrow = useNarrowScreen();

  const catalog = useMemo(() => saleProducts(inventories), [inventories]);
  const products = useMemo(
    () => catalog.filter((product) => inventoryIds.includes(product.inventoryId)),
    [catalog, inventoryIds],
  );
  const availableByKey = useMemo(() => {
    const totals = new Map<string, number>();
    if (!stockReady) return totals;
    for (const product of catalog) {
      const key = stockKey(product.inventoryId, product.productId);
      if (totals.has(key)) continue;
      totals.set(key, availablePackages(product.initialPackages, sold[key] || 0));
    }
    return totals;
  }, [catalog, sold, stockReady]);
  const availableByInventory = useMemo(() => {
    const totals = new Map<string, number>();
    if (!stockReady) return totals;
    const seen = new Set<string>();
    for (const product of catalog) {
      const key = stockKey(product.inventoryId, product.productId);
      if (seen.has(key)) continue;
      seen.add(key);
      totals.set(product.inventoryId, (totals.get(product.inventoryId) || 0) + (availableByKey.get(key) || 0));
    }
    return totals;
  }, [availableByKey, catalog, stockReady]);
  const addedKeys = useMemo(
    () => new Set(lines.map((line) => stockKey(line.inventoryId, line.productId))),
    [lines],
  );
  const productsToAdd = products.filter((product) => !addedKeys.has(stockKey(product.inventoryId, product.productId)));
  const review = useMemo(
    () => reviewSale(lines, products, sold),
    [lines, products, sold],
  );

  useEffect(() => {
    let cancelled = false;
    void readSellerName()
      .then((name) => {
        if (!cancelled) setSellerName(name);
      })
      .catch(() => {
        if (!cancelled) setSellerName("");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!catalog.length) {
      setSold({});
      setStockReady(true);
      return;
    }
    setStockReady(false);
    void readSoldPackages(catalog.map((product) => ({ inventoryId: product.inventoryId, productId: product.productId })))
      .then((next) => {
        if (!cancelled) {
          setSold(next);
          setError("");
          setStockReady(true);
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "No se pudo consultar los paquetes vendidos.");
      });
    return () => {
      cancelled = true;
    };
  }, [catalog]);

  const productAvailable = (product: SaleProduct): number | null => {
    if (!stockReady) return null;
    return availableByKey.get(stockKey(product.inventoryId, product.productId)) ?? null;
  };

  const selectedToAdd = productsToAdd.find((product) => stockKey(product.inventoryId, product.productId) === addId) ?? null;
  const selectedAvailable = selectedToAdd ? productAvailable(selectedToAdd) : null;

  const addLine = () => {
    if (!selectedToAdd || selectedAvailable == null || selectedAvailable <= 0) return;
    setAddId("");
    setLines((current) => [
      ...current,
      { id: uuid(), inventoryId: selectedToAdd.inventoryId, productId: selectedToAdd.productId, quantity: null },
    ]);
  };

  const resetSale = () => {
    setLines([]);
    setAddId("");
    setOperationId(uuid());
    setRegisteredId("");
    setVoucher(null);
    setError("");
    setConfirming(false);
  };

  const confirm = async () => {
    if (!review.ok || savingRef.current || registeredId) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    const outcome = await registerSale(
      operationId,
      lines.map((line) => ({
        inventoryId: line.inventoryId,
        productId: line.productId,
        quantity: line.quantity as number,
      })),
    )
      .then((sale) => ({ sale }))
      .catch((reason: unknown) => ({ error: reason instanceof Error ? reason.message : "No se pudo registrar la venta." }));
    const registered = voucherAfterAttempt(outcome);
    savingRef.current = false;
    setSaving(false);
    if (!registered) {
      setVoucher(null);
      const detail = "error" in outcome ? outcome.error : "No se pudo registrar la venta.";
      setError(detail);
      return;
    }
    setError("");
    setConfirming(false);
    setRegisteredId(registered.operationId);
    setVoucher(registered);
    setSold((current) => {
      const next = { ...current };
      for (const line of registered.lines) {
        const key = stockKey(line.inventoryId, line.productId);
        next[key] = (next[key] || 0) + line.quantity;
      }
      return next;
    });
    void readSoldPackages(registered.lines.map((line) => ({
      inventoryId: line.inventoryId,
      productId: line.productId,
    })))
      .then((next) => setSold((current) => ({ ...current, ...next })))
      .catch(() => undefined);
  };

  return (
    <Box sx={{ display: "grid", gap: { xs: 1.25, md: 2 } }}>
      <Box>
        <Typography variant="h5">Ventas</Typography>
        <Typography variant="body2" color="text.secondary">
          {sellerName ? `Vendedor: ${sellerName}` : "El nombre se toma del perfil del usuario."} Una venta puede incluir productos de varios inventarios y facturas.
        </Typography>
      </Box>
      {error && !confirming ? <Notice tone="error" action={<Button size="small" onClick={() => setError("")}>Cerrar</Button>}>{registrationError(error)}</Notice> : null}
      <Card variant="outlined">
        <CardContent sx={{ display: "grid", gap: 1.5 }}>
          <TextField
            select
            label="Inventarios"
            value={inventoryIds}
            onChange={(event) => {
              const value = event.target.value;
              const next = typeof value === "string" ? value.split(",") : value;
              setInventoryIds(next);
              setLines((current) => current.filter((line) => next.includes(line.inventoryId)));
            }}
            sx={{ "& .MuiSelect-select": { whiteSpace: "normal" } }}
            slotProps={{
              select: {
                multiple: true,
                renderValue: (selected) => {
                  const ids = selected as string[];
                  if (!ids.length) return "Selecciona uno o varios";
                  return ids.map((id) => {
                    const inventory = inventories.find((item) => item.id === id);
                    const name = inventory?.name || id;
                    const available = availableByInventory.get(id);
                    return stockReady && available != null ? `${name} — ${availabilityLabel(available)}` : name;
                  }).join(", ");
                },
              },
            }}
          >
            {inventories.map((inventory) => (
              <MenuItem key={inventory.id} value={inventory.id} sx={{ alignItems: "center", gap: 1, whiteSpace: "normal", py: 1 }}>
                <Typography sx={{ flex: "1 1 140px", minWidth: 0, fontWeight: 700, overflowWrap: "anywhere" }}>
                  {inventory.name}
                </Typography>
                <AvailabilityBadge count={stockReady ? availableByInventory.get(inventory.id) ?? 0 : null} />
              </MenuItem>
            ))}
          </TextField>
          <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "center" }}>
            <TextField
              select
              label="Producto"
              value={productsToAdd.some((product) => stockKey(product.inventoryId, product.productId) === addId) ? addId : ""}
              onChange={(event) => setAddId(event.target.value)}
              disabled={!productsToAdd.length}
              sx={{ "& .MuiSelect-select": { whiteSpace: "normal" } }}
              slotProps={{
                select: {
                  renderValue: (selected) => {
                    const key = String(selected || "");
                    const product = productsToAdd.find((item) => stockKey(item.inventoryId, item.productId) === key);
                    if (!product) return "";
                    return (
                      <Box sx={{ minWidth: 0 }}>
                        <Typography noWrap sx={{ fontSize: "0.8125rem", fontWeight: 650, lineHeight: 1.2 }}>
                          {product.productName}
                        </Typography>
                        <Typography noWrap variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.2 }}>
                          {product.inventoryName} · {money(product.appliedPrice)} por paquete · {availabilityLabel(productAvailable(product))}
                        </Typography>
                      </Box>
                    );
                  },
                },
              }}
            >
              {productsToAdd.map((product) => {
                const available = productAvailable(product);
                const blocked = available != null && available <= 0;
                return (
                  <MenuItem
                    key={stockKey(product.inventoryId, product.productId)}
                    value={stockKey(product.inventoryId, product.productId)}
                    disabled={blocked}
                    sx={{ alignItems: "center", gap: 1, whiteSpace: "normal", py: 0.75 }}
                  >
                    <Box sx={{ flex: "1 1 140px", minWidth: 0 }}>
                      <Typography sx={{ fontSize: "0.8125rem", fontWeight: 650, lineHeight: 1.25, overflowWrap: "anywhere" }}>
                        {product.productName}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.2, overflowWrap: "anywhere" }}>
                        {product.inventoryName}
                      </Typography>
                      <Typography sx={{ fontSize: "0.8125rem", fontWeight: 700, lineHeight: 1.25, color: "#1A56DB", overflowWrap: "anywhere" }}>
                        {money(product.appliedPrice)} por paquete
                      </Typography>
                    </Box>
                    <AvailabilityBadge count={available} />
                  </MenuItem>
                );
              })}
            </TextField>
            <Button
              variant="outlined"
              startIcon={<AddIcon />}
              onClick={addLine}
              disabled={!selectedToAdd || selectedAvailable == null || selectedAvailable <= 0}
              sx={{ minHeight: 40, whiteSpace: "nowrap", px: { xs: 1.25, md: 2 } }}
            >
              Agregar
            </Button>
          </Box>
          {!inventories.length ? <Alert severity="info">Todavía no hay inventarios.</Alert> : null}
        </CardContent>
      </Card>
      {lines.length ? (
        <Card variant="outlined" sx={{ boxShadow: "0 1px 2px rgba(26, 28, 30, 0.04)", borderColor: "rgba(26, 28, 30, 0.08)" }}>
          <CardContent sx={{ display: "grid", gap: 1 }}>
            <Typography variant="subtitle2">Resumen de la venta</Typography>
            <Box sx={{ display: "grid", gap: 0.75, gridTemplateColumns: "1fr 1fr" }}>
              <SummaryMetric icon={<ShoppingBagOutlinedIcon fontSize="small" />} label="Venta total" value={money(review.totals.salesTotal)} background="#E6F4EA" color="#0D652D" emphasis />
              <SummaryMetric icon={<AccountBalanceWalletOutlinedIcon fontSize="small" />} label="Ganancia del inversionista" value={money(review.totals.investorNet)} background="#FFF7F0" color="#C05A12" emphasis />
            </Box>
            <Box sx={{ display: "grid", gap: 0.75, gridTemplateColumns: { xs: "1fr 1fr", "@media (min-width: 768px)": "1fr 1fr 1fr" }, "& > :last-child:nth-child(odd)": { "@media (max-width: 767px)": { gridColumn: "1 / -1" } } }}>
              <SummaryMetric icon={<Inventory2OutlinedIcon fontSize="small" />} label="Paquetes de la venta" value={qty(review.totals.packageCount)} background="#F8F9FB" color="#44474E" />
              <SummaryMetric icon={<ShowChartOutlinedIcon fontSize="small" />} label="Utilidad bruta" value={money(review.totals.grossProfit)} background="#F8F9FB" color="#44474E" />
              <SummaryMetric icon={<PersonOutlineOutlinedIcon fontSize="small" />} label="Ganancia del vendedor" value={money(review.totals.vendorProfit)} background="#F7F4FC" color="#6D4BA1" />
            </Box>
          </CardContent>
        </Card>
      ) : null}
      <Box sx={{ display: "grid", gap: { xs: 1.25, md: 2 } }}>
        {lines.map((line, index) => {
          const row = review.rows[index];
          return (
            <LineCard
              key={line.id}
              row={row}
              onQuantity={(value) => {
                const limit = row.available == null ? null : Math.max(0, row.available);
                if (value != null && limit != null && value > limit) return;
                setLines((current) => current.map((item) => (item.id === line.id ? { ...item, quantity: value } : item)));
              }}
              onRemove={() => {
                setLines((current) => current.filter((item) => item.id !== line.id));
              }}
            />
          );
        })}
      </Box>
      <Box sx={{ display: "flex", justifyContent: { xs: "stretch", sm: "flex-end" } }}>
        <Button
          variant="contained"
          sx={{ minHeight: 48, width: { xs: "100%", sm: "auto" } }}
          disabled={!review.ok || !stockReady || saving || !!registeredId}
          onClick={() => {
            setPreviewAt(new Date().toISOString());
            setConfirming(true);
          }}
        >
          Revisar venta
        </Button>
      </Box>
      <Dialog
        open={confirming}
        onClose={() => { if (!saving) setConfirming(false); }}
        fullScreen={narrow}
        fullWidth
        maxWidth="sm"
        slotProps={{ paper: { sx: { borderRadius: narrow ? 0 : "20px", overflow: "hidden", boxShadow: "0 12px 32px rgba(26, 28, 30, 0.12)" } } }}
      >
        <DialogContent sx={{ p: 0 }}>
          <Box sx={{ display: "grid", gap: 1.5, px: { xs: 2, sm: 2.5 }, pt: narrow ? "calc(18px + env(safe-area-inset-top))" : 2.25, pb: 2.25, bgcolor: "#E8F0FE" }}>
            <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1.25, flexWrap: "wrap" }}>
              <Box sx={{ width: 42, height: 42, borderRadius: "12px", bgcolor: "#1A56DB", color: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <ReceiptLongOutlinedIcon fontSize="small" />
              </Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="caption" sx={{ color: "#1A56DB", fontWeight: 700, letterSpacing: 0.6 }}>GESTIÓN COMERCIAL</Typography>
                <Typography sx={{ fontWeight: 800, fontSize: { xs: "1.15rem", sm: "1.35rem" }, letterSpacing: 0.3, lineHeight: 1.15 }}>COMPROBANTE DE VENTA</Typography>
              </Box>
              <Box sx={{ px: 1.25, py: 0.45, borderRadius: 999, bgcolor: "#FEF4D6", flexShrink: 0 }}>
                <Typography variant="caption" sx={{ fontWeight: 700, color: "#8D4E00" }}>Por confirmar</Typography>
              </Box>
            </Box>
            <Box sx={{ px: 1.25, py: 0.75, borderRadius: "10px", bgcolor: "#FFFFFF" }}>
              <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>Operación {operationId}</Typography>
            </Box>
            <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" } }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1.25, py: 1, borderRadius: "10px", bgcolor: "#FFFFFF", minWidth: 0 }}>
                <CalendarTodayOutlinedIcon sx={{ fontSize: 18, color: "#1A56DB" }} />
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.1 }}>Fecha</Typography>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>{dateTimeLabel(previewAt)}</Typography>
                </Box>
              </Box>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1.25, py: 1, borderRadius: "10px", bgcolor: "#FFFFFF", minWidth: 0 }}>
                <PersonOutlineOutlinedIcon sx={{ fontSize: 18, color: "#1A56DB" }} />
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.1 }}>Vendedor</Typography>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>{sellerName || "Sin nombre"}</Typography>
                </Box>
              </Box>
            </Box>
          </Box>
          <Box sx={{ display: "grid", gap: 1.25, px: { xs: 2, sm: 2.5 }, py: 2 }}>
            {review.rows.map((row, index) => (
              <Box key={`${row.inventoryId}-${row.productId}-${index}`} sx={{ display: "grid", gap: 1, p: 1.5, borderRadius: "12px", bgcolor: "#F8F9FB" }}>
                <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
                  <Box sx={{ width: 34, height: 34, borderRadius: "10px", bgcolor: "#E8F0FE", color: "#1A56DB", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Inventory2OutlinedIcon sx={{ fontSize: 18 }} />
                  </Box>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography sx={{ fontWeight: 700, fontSize: "1.05rem", lineHeight: 1.25 }}>{row.product?.productName || "Producto"}</Typography>
                    <Typography variant="body2" color="text.secondary">{row.product?.inventoryName || "Inventario"} · Factura {row.product?.invoiceNumber || "sin número"}</Typography>
                  </Box>
                  <Typography sx={{ fontWeight: 800, fontSize: "1.05rem", flexShrink: 0 }}>{money(row.financials?.salesTotal || 0)}</Typography>
                </Box>
                <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: "1fr 1fr" }}>
                  <Box sx={{ px: 1.25, py: 0.85, borderRadius: "10px", bgcolor: "#FFFFFF" }}>
                    <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>Paquetes</Typography>
                    <Typography sx={{ fontWeight: 700 }}>{qty(row.quantity || 0)}</Typography>
                  </Box>
                  <Box sx={{ px: 1.25, py: 0.85, borderRadius: "10px", bgcolor: "#FFFFFF" }}>
                    <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>Precio por paquete</Typography>
                    <Typography sx={{ fontWeight: 700 }}>{voucherPrice(row.product?.appliedPrice || 0)}</Typography>
                  </Box>
                </Box>
              </Box>
            ))}
            <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, px: 2, py: 1.75, borderRadius: "12px", bgcolor: "#E6F4EA" }}>
              <Box>
                <Typography variant="caption" sx={{ color: "#0D652D", fontWeight: 700 }}>Venta total</Typography>
                <Typography sx={{ fontWeight: 800, color: "#0D652D", fontSize: { xs: "1.55rem", sm: "1.85rem" }, lineHeight: 1.1 }}>{money(review.totals.salesTotal)}</Typography>
              </Box>
              <ShoppingBagOutlinedIcon sx={{ color: "#0D652D", fontSize: 28 }} />
            </Box>
            <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "1fr 1fr", sm: "1fr 1fr" } }}>
              <SummaryMetric icon={<Inventory2OutlinedIcon fontSize="small" />} label="Total de paquetes" value={qty(review.totals.packageCount)} background="#F8F9FB" color="#44474E" />
              <SummaryMetric icon={<ShowChartOutlinedIcon fontSize="small" />} label="Utilidad bruta" value={money(review.totals.grossProfit)} background="#F8F9FB" color="#44474E" />
              <SummaryMetric icon={<PersonOutlineOutlinedIcon fontSize="small" />} label="Ganancia del vendedor" value={money(review.totals.vendorProfit)} background="#F7F4FC" color="#6D4BA1" />
              <SummaryMetric icon={<AccountBalanceWalletOutlinedIcon fontSize="small" />} label="Ganancia del inversionista" value={money(review.totals.investorNet)} background="#FFF7F0" color="#C05A12" />
            </Box>
            {vendorCommissionNote(review.totals.vendorProfit, review.rows.map((row) => row.financials?.vendorProfit || 0)) ? (
              <Typography variant="body2" sx={{ color: "#8D4E00" }}>
                {vendorCommissionNote(review.totals.vendorProfit, review.rows.map((row) => row.financials?.vendorProfit || 0))}
              </Typography>
            ) : null}
          </Box>
        </DialogContent>
        {error ? (
          <Box sx={{ px: 2.5, pb: 1 }}>
            <Notice tone="error">{registrationError(error)}</Notice>
          </Box>
        ) : null}
        <DialogActions sx={dialogActionsSx}>
          <Button onClick={() => setConfirming(false)} disabled={saving}>Cancelar</Button>
          <Button
            variant="contained"
            onClick={() => void confirm()}
            disabled={saving || !review.ok || !!registeredId}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {saving ? "Registrando venta..." : "Confirmar y registrar"}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={Boolean(voucher)}
        onClose={() => undefined}
        disableEscapeKeyDown
        fullScreen={narrow}
        fullWidth
        maxWidth="xs"
        slotProps={{ paper: { sx: { borderRadius: narrow ? 0 : "20px", boxShadow: "0 12px 32px rgba(26, 28, 30, 0.12)" } } }}
      >
        {voucher ? (
          <DialogContent sx={{ display: "grid", alignContent: "start", gridAutoRows: "min-content", justifyItems: "center", gap: 1, pt: narrow ? "calc(16px + env(safe-area-inset-top))" : 3, textAlign: "center" }}>
            <Box sx={{ width: 56, height: 56, borderRadius: "16px", bgcolor: "#E6F4EA", color: "#0D652D", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <CheckCircleOutlinedIcon />
            </Box>
            <Typography sx={{ fontWeight: 800, fontSize: "1.25rem", lineHeight: 1.25 }}>¡Venta registrada correctamente!</Typography>
            <Typography variant="body2" color="text.secondary">La operación se guardó exitosamente</Typography>
            <Box sx={{ width: "100%", display: "grid", gap: 1, mt: 0.5, textAlign: "left" }}>
              <Box sx={{ px: 1.5, py: 1.25, borderRadius: "12px", bgcolor: "#E6F4EA" }}>
                <Typography variant="caption" sx={{ color: "#0D652D", fontWeight: 700 }}>Venta total</Typography>
                <Typography sx={{ fontWeight: 800, color: "#0D652D", fontSize: "1.45rem", lineHeight: 1.15 }}>{money(voucher.salesTotal)}</Typography>
              </Box>
              <Box sx={{ px: 1.5, py: 1.1, borderRadius: "12px", bgcolor: "#F8F9FB" }}>
                <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>Total de paquetes vendidos</Typography>
                <Typography sx={{ fontWeight: 700 }}>{qty(voucher.packageCount)}</Typography>
              </Box>
              <Box sx={{ px: 1.5, py: 1.1, borderRadius: "12px", bgcolor: "#F8F9FB" }}>
                <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>Identificador de operación</Typography>
                <Typography sx={{ fontWeight: 700, fontSize: "0.8rem", overflowWrap: "anywhere" }}>{voucher.operationId}</Typography>
              </Box>
            </Box>
          </DialogContent>
        ) : null}
        <DialogActions sx={{ display: "grid", gap: 1, px: 2.5, pb: "calc(20px + env(safe-area-inset-bottom))", "& .MuiButton-root": { minHeight: 48 } }}>
          <Button variant="contained" startIcon={<FileDownloadOutlinedIcon />} disabled={!voucher} onClick={() => voucher && downloadSaleVoucher(voucher)}>Descargar voucher PDF</Button>
          <Button variant="outlined" startIcon={<PrintOutlinedIcon />} disabled={!voucher} onClick={() => voucher && printSaleVoucher(voucher)}>Imprimir comprobante</Button>
          <Button onClick={resetSale}>Cerrar</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
