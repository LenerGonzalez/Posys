import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { v4 as uuid } from "uuid";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  IconButton,
  InputAdornment,
  MenuItem,
  SwipeableDrawer,
  TextField,
  Typography,
} from "@mui/material";
import AccountBalanceWalletOutlinedIcon from "@mui/icons-material/AccountBalanceWalletOutlined";
import AddIcon from "@mui/icons-material/Add";
import CheckCircleOutlinedIcon from "@mui/icons-material/CheckCircleOutlined";
import ClearIcon from "@mui/icons-material/Clear";
import CloseIcon from "@mui/icons-material/Close";
import SearchIcon from "@mui/icons-material/Search";
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
import { useNarrowScreen } from "./screen";
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

function AvailabilityBadge({ count, failed = false }: { count: number | null; failed?: boolean }) {
  const tone = failed ? { background: "#FCE8E6", color: "#A50E0E" } : availabilityTone(count);
  return (
    <Box sx={{ flexShrink: 0, px: 1, py: 0.35, borderRadius: "999px", bgcolor: tone.background }}>
      <Typography variant="caption" sx={{ fontWeight: 700, color: tone.color, whiteSpace: "nowrap" }}>
        {failed ? "No disponible" : availabilityLabel(count)}
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

function useVisibleSheetFrame(open: boolean): { height: string; bottom: number } {
  const [frame, setFrame] = useState({ height: "90dvh", bottom: 0 });
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const viewport = window.visualViewport;
      const visibleHeight = viewport?.height ?? window.innerHeight;
      const offsetTop = viewport?.offsetTop ?? 0;
      const covered = Math.max(0, window.innerHeight - offsetTop - visibleHeight);
      setFrame({ height: `${Math.round(visibleHeight * 0.9)}px`, bottom: Math.round(covered) });
    };
    update();
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [open]);
  return frame;
}

function ProductSheet({
  open,
  inventoryLabel,
  products,
  query,
  stockReady,
  stockFailed,
  stockError,
  selectedKey,
  onQuery,
  onClose,
  onRetry,
  onSelect,
  productAvailable,
}: {
  open: boolean;
  inventoryLabel: string;
  products: SaleProduct[];
  query: string;
  stockReady: boolean;
  stockFailed: boolean;
  stockError: string;
  selectedKey: string;
  onQuery: (value: string) => void;
  onClose: () => void;
  onRetry: () => void;
  onSelect: (product: SaleProduct) => void;
  productAvailable: (product: SaleProduct) => number | null;
}) {
  const frame = useVisibleSheetFrame(open);
  const normalized = query.trim().toLowerCase();
  const visible = normalized
    ? products.filter((product) => product.productName.toLowerCase().includes(normalized))
    : products;
  return (
    <SwipeableDrawer
      anchor="bottom"
      open={open}
      onOpen={() => undefined}
      onClose={onClose}
      disableSwipeToOpen
      swipeAreaWidth={0}
      slotProps={{
        paper: {
          sx: {
            left: 0,
            right: 0,
            width: "100%",
            maxWidth: "100%",
            bottom: frame.bottom,
            height: frame.height,
            maxHeight: frame.height,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            bgcolor: "#FFFFFF",
            borderTopLeftRadius: "20px",
            borderTopRightRadius: "20px",
            boxShadow: "0 -8px 32px rgba(26, 28, 30, 0.18)",
            pb: "env(safe-area-inset-bottom)",
          },
        },
      }}
    >
      <Box sx={{ flexShrink: 0, px: 2, pt: 1, pb: 1.25, display: "grid", gap: 1.25, bgcolor: "#FFFFFF" }}>
        <Box sx={{ width: 36, height: 4, borderRadius: "999px", bgcolor: "rgba(26, 28, 30, 0.2)", justifySelf: "center" }} />
        <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontWeight: 700, fontSize: "1.125rem", lineHeight: 1.3 }}>Seleccionar producto</Typography>
            <Typography color="text.secondary" sx={{ display: "block", fontSize: "0.875rem", lineHeight: 1.35, overflowWrap: "break-word" }}>
              {inventoryLabel}
            </Typography>
          </Box>
          <IconButton aria-label="Cerrar" onClick={onClose} sx={{ mt: -0.5 }}>
            <CloseIcon />
          </IconButton>
        </Box>
        <TextField
          fullWidth
          placeholder="Buscar producto..."
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          sx={{ "& .MuiInputBase-input": { fontSize: "16px" } }}
          slotProps={{
            htmlInput: { autoComplete: "off", enterKeyHint: "search", "aria-label": "Buscar producto" },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ color: "#5C6370" }} />
                </InputAdornment>
              ),
              endAdornment: query ? (
                <IconButton aria-label="Limpiar búsqueda" size="small" onClick={() => onQuery("")}>
                  <ClearIcon fontSize="small" />
                </IconButton>
              ) : null,
            },
          }}
        />
        {stockFailed ? (
          <Alert severity="error" action={<Button color="inherit" size="small" onClick={onRetry}>Reintentar</Button>}>
            {stockError || "No se pudieron consultar los productos."}
          </Alert>
        ) : null}
        {!stockReady && !stockFailed ? (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, color: "#44474E" }}>
            <CircularProgress size={16} />
            <Typography sx={{ fontSize: "0.875rem" }}>Consultando disponibilidad</Typography>
          </Box>
        ) : null}
      </Box>
      <Box role="listbox" aria-label="Productos" sx={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
        {visible.length ? visible.map((product) => {
          const key = stockKey(product.inventoryId, product.productId);
          const available = productAvailable(product);
          const unavailable = available != null && available <= 0;
          return (
            <Box
              component="button"
              type="button"
              role="option"
              key={key}
              aria-selected={key === selectedKey}
              aria-disabled={unavailable}
              disabled={unavailable}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(product);
              }}
              sx={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: "4px",
                width: "100%",
                m: 0,
                px: 2,
                py: 1.25,
                textAlign: "left",
                border: 0,
                borderBottom: "1px solid rgba(26, 28, 30, 0.08)",
                bgcolor: key === selectedKey ? "#E8F0FE" : "#FFFFFF",
                opacity: unavailable ? 0.55 : 1,
                cursor: unavailable ? "default" : "pointer",
              }}
            >
              <Typography sx={{ width: "100%", fontWeight: 700, fontSize: "1rem", lineHeight: 1.3, overflowWrap: "break-word" }}>
                {product.productName}
              </Typography>
              <Typography color="text.secondary" sx={{ width: "100%", fontSize: "0.8125rem", lineHeight: 1.3, overflowWrap: "break-word" }}>
                {product.inventoryName}
              </Typography>
              <Typography sx={{ fontWeight: 700, fontSize: "0.9375rem", lineHeight: 1.3, color: "#1A56DB" }}>
                {money(product.appliedPrice)} por paquete
              </Typography>
              <AvailabilityBadge count={available} failed={stockFailed} />
            </Box>
          );
        }) : (
          <Typography sx={{ px: 2, py: 3, color: "#44474E", fontSize: "0.9375rem" }}>
            {normalized ? "Ningún producto coincide con la búsqueda." : "No hay productos para agregar."}
          </Typography>
        )}
      </Box>
    </SwipeableDrawer>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography color="text.secondary" sx={{ display: "block", lineHeight: 1.25, fontSize: { xs: "0.8125rem", md: "0.875rem" } }}>
        {label}
      </Typography>
      <Typography sx={{ fontWeight: 700, fontSize: { xs: "1.05rem", md: "1.15rem" }, lineHeight: 1.25, overflowWrap: "anywhere" }}>{value}</Typography>
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
        <Typography sx={{ color, display: "block", lineHeight: 1.25, fontSize: { xs: "0.8125rem", md: "0.875rem" }, fontWeight: 600 }}>{label}</Typography>
        <Typography sx={{ fontWeight: 800, fontSize: emphasis ? { xs: "1.25rem", md: "1.4rem" } : { xs: "1.125rem", md: "1.25rem" }, lineHeight: 1.2, overflowWrap: "anywhere" }}>{value}</Typography>
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
            <Typography component="h6" variant="body1" sx={{ m: 0, fontWeight: 700, fontSize: { xs: "1.125rem", md: "1.35rem" }, lineHeight: 1.25 }}>
              {product?.productName || "Producto no disponible"}
            </Typography>
            <Typography color="text.secondary" sx={{ display: "block", fontSize: { xs: "0.875rem", md: "0.9375rem" }, lineHeight: 1.35, overflowWrap: "anywhere" }}>
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
          <Typography color="text.secondary" sx={{ fontSize: { xs: "0.875rem", md: "1rem" }, lineHeight: 1.4 }}>
            {commissionMethodLabel(product.commissionMethod)} · Comisión aplicada {percent(product.vendorSharePercent, Number.isInteger(product.vendorSharePercent) ? 0 : 2)}
          </Typography>
        ) : null}
        <Box
          sx={{
            display: "grid",
            gap: 1.25,
            p: { xs: 1.25, md: 1.75 },
            borderRadius: "16px",
            bgcolor: "#F3F7FE",
            border: "1.5px solid #1A56DB",
          }}
        >
          {availableLabel != null ? (
            <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
              <Box sx={{ px: 1.25, py: 0.6, borderRadius: "999px", bgcolor: availableTone.background }}>
                <Typography sx={{ fontWeight: 700, fontSize: "0.875rem", lineHeight: 1.3, color: availableTone.color }}>
                  Máximo disponible: {availableLabel}
                </Typography>
              </Box>
            </Box>
          ) : null}
          <Typography component="label" sx={{ display: "block", color: "#1A56DB", fontWeight: 700, fontSize: { xs: "1rem", md: "1.0625rem" }, lineHeight: 1.3 }}>
            Cantidad de paquetes a vender
          </Typography>
          <NumericField
            label="Cantidad de paquetes a vender"
            placeholder="Introduce la cantidad"
            kind="packages"
            size="medium"
            value={row.quantity}
            maximum={row.available == null ? undefined : Math.max(0, row.available)}
            onCommit={onQuantity}
            adornment={<Inventory2OutlinedIcon sx={{ color: "#1A56DB" }} />}
            adornmentPosition="start"
            sx={{
              "& .MuiOutlinedInput-root": {
                bgcolor: "#FFFFFF",
                minHeight: 56,
                "& fieldset": { borderColor: "#1A56DB", borderWidth: "1.5px" },
                "&:hover fieldset": { borderColor: "#1A56DB" },
                "&:focus-within fieldset, &.Mui-focused fieldset": { borderColor: "#1A56DB", borderWidth: "2px" },
                "&.Mui-error fieldset, &.Mui-error:focus-within fieldset": { borderColor: "#A50E0E", borderWidth: "2px" },
              },
              "& .MuiInputLabel-root": {
                position: "absolute",
                width: "1px",
                height: "1px",
                padding: 0,
                margin: "-1px",
                overflow: "hidden",
                clip: "rect(0, 0, 0, 0)",
                whiteSpace: "nowrap",
                border: 0,
              },
              "& .MuiOutlinedInput-notchedOutline legend": { maxWidth: "0.01px" },
              "& .MuiInputBase-input": { fontSize: { xs: "1.25rem", md: "1.375rem" }, fontWeight: 700, py: 1.5 },
              "& .MuiInputBase-input::placeholder": { color: "#5C6370", opacity: 1, fontWeight: 500 },
              "& .MuiFormHelperText-root": { mx: 0, mt: 1, fontSize: "0.875rem", lineHeight: 1.35 },
              "& .MuiFormHelperText-root.Mui-error": {
                color: "#A50E0E",
                bgcolor: "#FCE8E6",
                borderRadius: "8px",
                px: 1,
                py: 0.75,
              },
            }}
          />
          {row.message ? <Notice tone="warning">{row.message}</Notice> : null}
        </Box>
      </CardContent>
    </Card>
  );
}

export default function SalesRegister({ inventories }: { inventories: PricingInventory[] }) {
  const [inventoryIds, setInventoryIds] = useState<string[]>([]);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [addId, setAddId] = useState("");
  const [productQuery, setProductQuery] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetQuery, setSheetQuery] = useState("");
  const blockProductOpenRef = useRef(0);
  const [sold, setSold] = useState<Record<string, number>>({});
  const [stockReady, setStockReady] = useState(false);
  const [stockError, setStockError] = useState("");
  const [stockAttempt, setStockAttempt] = useState(0);
  const stockReadyRef = useRef(false);
  stockReadyRef.current = stockReady;
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
  useEffect(() => {
    if (!narrow) setSheetOpen(false);
  }, [narrow]);

  const catalog = useMemo(() => saleProducts(inventories), [inventories]);
  const catalogKey = useMemo(
    () => catalog.map((product) => stockKey(product.inventoryId, product.productId)).join("|"),
    [catalog],
  );
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
  const availableAfterSale = useMemo(() => {
    const seen = new Set<string>();
    let total = 0;
    let known = false;
    for (const row of review.rows) {
      const key = stockKey(row.inventoryId, row.productId);
      if (seen.has(key) || row.availableAfter == null) continue;
      seen.add(key);
      known = true;
      total += row.availableAfter;
    }
    return known ? total : null;
  }, [review.rows]);

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
    const keys = catalog.map((product) => ({ inventoryId: product.inventoryId, productId: product.productId }));
    if (!keys.length) {
      setSold({});
      setStockReady(true);
      setStockError("");
      return;
    }
    const background = stockReadyRef.current;
    if (!background) setStockReady(false);
    setStockError("");
    void readSoldPackages(keys)
      .then((next) => {
        if (cancelled) return;
        setSold(next);
        setStockError("");
        setStockReady(true);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setStockError(reason instanceof Error ? reason.message : "No se pudieron consultar los paquetes disponibles.");
        if (!background) setStockReady(false);
      });
    return () => {
      cancelled = true;
    };
    // catalogKey identifica los productos. Evita reiniciar la lectura si el arreglo cambia de identidad con el mismo contenido.
  }, [catalogKey, stockAttempt]);

  useEffect(() => {
    const retry = () => setStockAttempt((current) => current + 1);
    const onVisible = () => {
      if (document.visibilityState === "visible") retry();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) retry();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  const productAvailable = (product: SaleProduct): number | null => {
    if (!stockReady) return null;
    return availableByKey.get(stockKey(product.inventoryId, product.productId)) ?? null;
  };

  const selectedToAdd = productsToAdd.find((product) => stockKey(product.inventoryId, product.productId) === addId) ?? null;
  const selectedAvailable = selectedToAdd ? productAvailable(selectedToAdd) : null;
  const stockFailed = Boolean(stockError) && !stockReady;
  const showingSelectedProduct = Boolean(
    selectedToAdd && productQuery.trim().toLowerCase() === selectedToAdd.productName.trim().toLowerCase(),
  );

  const updateQuantity = (lineId: string, available: number | null, value: number | null) => {
    const limit = available == null ? null : Math.max(0, available);
    if (value != null && limit != null && value > limit) return;
    setLines((current) => current.map((item) => (item.id === lineId ? { ...item, quantity: value } : item)));
  };

  const removeLine = (lineId: string) => {
    const remaining = lines.filter((item) => item.id !== lineId);
    setLines(remaining);
    if (confirming && remaining.length === 0) setConfirming(false);
  };

  const addLine = () => {
    if (!selectedToAdd || selectedAvailable == null || selectedAvailable <= 0) return;
    setAddId("");
    setProductQuery("");
    setLines((current) => [
      ...current,
      { id: uuid(), inventoryId: selectedToAdd.inventoryId, productId: selectedToAdd.productId, quantity: null },
    ]);
  };

  const resetSale = () => {
    setLines([]);
    setAddId("");
    setProductQuery("");
    setOperationId(uuid());
    setRegisteredId("");
    setVoucher(null);
    setError("");
    setConfirming(false);
  };

  const discardSale = () => {
    if (saving) return;
    if (lines.length > 0 && !window.confirm("¿Descartar esta venta? Se perderán los productos y las cantidades ingresadas.")) return;
    resetSale();
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
      {stockError ? (
        <Alert
          severity="error"
          action={<Button color="inherit" size="small" onClick={() => setStockAttempt((current) => current + 1)}>Reintentar</Button>}
        >
          {stockError}
        </Alert>
      ) : null}
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
              setProductQuery("");
              setAddId("");
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
                <AvailabilityBadge count={stockReady ? availableByInventory.get(inventory.id) ?? 0 : null} failed={stockFailed} />
              </MenuItem>
            ))}
          </TextField>
          <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "start" }}>
            <Box sx={{ minWidth: 0 }}>
              {narrow ? (
                <TextField
                  fullWidth
                  label="Producto"
                  placeholder="Buscar producto"
                  value={selectedToAdd?.productName ?? ""}
                  disabled={!productsToAdd.length}
                  onClick={() => {
                    if (!productsToAdd.length || performance.now() < blockProductOpenRef.current) return;
                    setSheetQuery("");
                    setSheetOpen(true);
                  }}
                  sx={{ "& .MuiInputBase-input": { fontSize: "16px", cursor: "pointer" } }}
                  slotProps={{
                    htmlInput: { readOnly: true, inputMode: "none" },
                    input: {
                      readOnly: true,
                      sx: { cursor: "pointer" },
                      endAdornment: selectedToAdd ? (
                        <InputAdornment position="end">
                          <IconButton
                            aria-label="Limpiar búsqueda"
                            size="small"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={(event) => {
                              event.stopPropagation();
                              setAddId("");
                              setProductQuery("");
                            }}
                          >
                            <ClearIcon fontSize="small" />
                          </IconButton>
                        </InputAdornment>
                      ) : null,
                    },
                  }}
                />
              ) : (
              <Autocomplete
                key={inventoryIds.join("|")}
                fullWidth
                openOnFocus
                blurOnSelect
                options={productsToAdd}
                value={selectedToAdd}
                inputValue={productQuery}
                disabled={!productsToAdd.length}
                clearText="Limpiar búsqueda"
                noOptionsText="Ningún producto coincide con la búsqueda."
                getOptionLabel={(product) => product.productName}
                isOptionEqualToValue={(option, value) => stockKey(option.inventoryId, option.productId) === stockKey(value.inventoryId, value.productId)}
                getOptionDisabled={(product) => {
                  const available = productAvailable(product);
                  return available != null && available <= 0;
                }}
                filterOptions={(options, state) => {
                  const query = state.inputValue.trim().toLowerCase();
                  const selectedName = selectedToAdd?.productName.trim().toLowerCase() ?? "";
                  if (!query || query === selectedName) return options;
                  return options.filter((product) => product.productName.toLowerCase().includes(query));
                }}
                onInputChange={(_event, value, reason) => {
                  if (reason === "reset") {
                    setProductQuery(value);
                    return;
                  }
                  setProductQuery(value);
                }}
                onChange={(_event, product) => {
                  setAddId(product ? stockKey(product.inventoryId, product.productId) : "");
                  if (!product) setProductQuery("");
                }}
                slotProps={{
                  popper: {
                    placement: "bottom-start",
                    modifiers: [
                      { name: "preventOverflow", options: { padding: 8, altAxis: true } },
                      { name: "flip", options: { padding: 8 } },
                    ],
                  },
                  listbox: {
                    sx: { maxHeight: { xs: "min(40vh, 280px)", md: 360 }, overflowY: "auto" },
                  },
                }}
                renderOption={(props, product) => {
                  const { key, ...optionProps } = props;
                  const available = productAvailable(product);
                  return (
                    <Box
                      component="li"
                      key={key}
                      {...optionProps}
                      sx={{
                        "&&": {
                          display: "flex",
                          flexDirection: { xs: "column", md: "row" },
                          alignItems: { xs: "flex-start", md: "center" },
                          gap: "6px",
                          width: "100%",
                          whiteSpace: "normal",
                          py: "8px",
                        },
                      }}
                    >
                      <Box sx={{ minWidth: 0, width: { xs: "100%", md: "auto" }, flex: { md: "1 1 auto" } }}>
                        <Typography sx={{ fontSize: { xs: "1rem", md: "0.875rem" }, fontWeight: 700, lineHeight: 1.3 }}>
                          {product.productName}
                        </Typography>
                        <Typography color="text.secondary" sx={{ display: "block", fontSize: { xs: "0.875rem", md: "0.75rem" }, lineHeight: 1.3 }}>
                          {product.inventoryName}
                        </Typography>
                        <Typography sx={{ fontSize: { xs: "0.9375rem", md: "0.875rem" }, fontWeight: 700, lineHeight: 1.3, color: "#1A56DB" }}>
                          {money(product.appliedPrice)} por paquete
                        </Typography>
                      </Box>
                      <AvailabilityBadge count={available} failed={stockFailed} />
                    </Box>
                  );
                }}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Producto"
                    placeholder="Buscar producto"
                    sx={{ "& .MuiInputBase-input": { fontSize: { xs: "16px", md: "0.875rem" } } }}
                    slotProps={{
                      ...params.slotProps,
                      htmlInput: { ...params.slotProps.htmlInput, autoComplete: "off", enterKeyHint: "search" },
                      input: {
                        ...params.slotProps.input,
                        endAdornment: (
                          <>
                            {productQuery && !selectedToAdd ? (
                              <IconButton
                                aria-label="Limpiar búsqueda"
                                size="small"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => setProductQuery("")}
                              >
                                <ClearIcon fontSize="small" />
                              </IconButton>
                            ) : null}
                            {params.slotProps.input.endAdornment}
                          </>
                        ),
                      },
                    }}
                  />
                )}
              />
              )}
              {showingSelectedProduct && selectedToAdd ? (
                <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.2, px: 0.5, pt: 0.5 }}>
                  {selectedToAdd.inventoryName} · {money(selectedToAdd.appliedPrice)} por paquete · {stockFailed ? "No disponible" : availabilityLabel(productAvailable(selectedToAdd))}
                </Typography>
              ) : null}
            </Box>
            <Button
              variant="outlined"
              startIcon={<AddIcon />}
              onClick={addLine}
              disabled={!selectedToAdd || selectedAvailable == null || selectedAvailable <= 0}
              sx={{ minHeight: 40, mt: 0.5, whiteSpace: "nowrap", px: { xs: 1.25, md: 2 } }}
            >
              Agregar
            </Button>
          </Box>
          {narrow ? (
            <ProductSheet
              open={sheetOpen}
              inventoryLabel={inventoryIds.map((id) => inventories.find((item) => item.id === id)?.name || id).join(", ")}
              products={productsToAdd}
              query={sheetQuery}
              stockReady={stockReady}
              stockFailed={stockFailed}
              stockError={stockError}
              selectedKey={addId}
              onQuery={setSheetQuery}
              onClose={() => setSheetOpen(false)}
              onRetry={() => setStockAttempt((current) => current + 1)}
              onSelect={(product) => {
                blockProductOpenRef.current = performance.now() + 700;
                setAddId(stockKey(product.inventoryId, product.productId));
                setProductQuery(product.productName);
                setSheetQuery("");
                setSheetOpen(false);
              }}
              productAvailable={productAvailable}
            />
          ) : null}
          {!inventories.length ? <Alert severity="info">Todavía no hay inventarios.</Alert> : null}
        </CardContent>
      </Card>
      {lines.length ? (
        <Card variant="outlined" sx={{ boxShadow: "0 1px 2px rgba(26, 28, 30, 0.04)", borderColor: "rgba(26, 28, 30, 0.08)" }}>
          <CardContent sx={{ display: "grid", gap: 1 }}>
            <Typography sx={{ fontWeight: 700, fontSize: { xs: "1.05rem", md: "1.125rem" } }}>Resumen de la venta</Typography>
            <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}>
              <Box sx={{ display: "grid", gap: 0.75, alignContent: "start" }}>
                <SummaryMetric icon={<ShoppingBagOutlinedIcon fontSize="small" />} label="Venta total" value={money(review.totals.salesTotal)} background="#E6F4EA" color="#0D652D" emphasis />
                <SummaryMetric icon={<Inventory2OutlinedIcon fontSize="small" />} label="Paquetes de la venta" value={qty(review.totals.packageCount)} background="#F8F9FB" color="#44474E" />
                <SummaryMetric icon={<CheckCircleOutlinedIcon fontSize="small" />} label="Disponibles después" value={availableAfterSale == null ? "—" : qty(availableAfterSale)} background="#E7EDF4" color="#3A4654" />
              </Box>
              <Box sx={{ display: "grid", gap: 0.75, alignContent: "start" }}>
                <SummaryMetric icon={<ShowChartOutlinedIcon fontSize="small" />} label="Utilidad bruta" value={money(review.totals.grossProfit)} background="#F8F9FB" color="#44474E" />
                <SummaryMetric icon={<PersonOutlineOutlinedIcon fontSize="small" />} label="Ganancia del vendedor" value={money(review.totals.vendorProfit)} background="#F7F4FC" color="#6D4BA1" />
                <SummaryMetric icon={<AccountBalanceWalletOutlinedIcon fontSize="small" />} label="Ganancia del inversionista" value={money(review.totals.investorNet)} background="#FFF7F0" color="#C05A12" emphasis />
              </Box>
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
              onQuantity={(value) => updateQuantity(line.id, row.available, value)}
              onRemove={() => removeLine(line.id)}
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
        slotProps={{ paper: { sx: { borderRadius: narrow ? 0 : "20px", overflow: "hidden", boxShadow: "0 12px 32px rgba(26, 28, 30, 0.12)", display: "flex", flexDirection: "column" } } }}
      >
        <DialogContent sx={{ p: 0, flex: "1 1 auto !important", minHeight: 0, overflow: "auto" }}>
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
            <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: "1fr" }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1.25, py: 1, borderRadius: "10px", bgcolor: "#FFFFFF", minWidth: 0 }}>
                <CalendarTodayOutlinedIcon sx={{ fontSize: 18, color: "#1A56DB" }} />
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.1 }}>Fecha</Typography>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>{dateTimeLabel(previewAt)}</Typography>
                </Box>
              </Box>
              {/* Vendedor oculto temporalmente en la confirmación.
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1.25, py: 1, borderRadius: "10px", bgcolor: "#FFFFFF", minWidth: 0 }}>
                <PersonOutlineOutlinedIcon sx={{ fontSize: 18, color: "#1A56DB" }} />
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.1 }}>Vendedor</Typography>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>{sellerName || "Sin nombre"}</Typography>
                </Box>
              </Box>
              */}
            </Box>
          </Box>
          <Box sx={{ display: "grid", gap: 1.25, px: { xs: 2, sm: 2.5 }, py: 2 }}>
            {lines.map((line, index) => {
              const row = review.rows[index];
              if (!row) return null;
              return (
                <Box key={line.id} sx={{ display: "grid", gap: 1, p: 1.5, borderRadius: "12px", bgcolor: "#F8F9FB", minWidth: 0 }}>
                  <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1, minWidth: 0 }}>
                    <Box sx={{ width: 34, height: 34, borderRadius: "10px", bgcolor: "#E8F0FE", color: "#1A56DB", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <Inventory2OutlinedIcon sx={{ fontSize: 18 }} />
                    </Box>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography sx={{ fontWeight: 700, fontSize: "1.05rem", lineHeight: 1.25, overflowWrap: "break-word" }}>{row.product?.productName || "Producto"}</Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "break-word" }}>{row.product?.inventoryName || "Inventario"} · Factura {row.product?.invoiceNumber || "sin número"}</Typography>
                    </Box>
                    <IconButton aria-label="Quitar producto" disabled={saving} onClick={() => removeLine(line.id)} sx={{ flexShrink: 0, mt: -0.5 }}>
                      <DeleteOutlinedIcon />
                    </IconButton>
                  </Box>
                  <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1, alignItems: "baseline", minWidth: 0 }}>
                    <Typography variant="body2" color="text.secondary" sx={{ minWidth: 0, overflowWrap: "break-word" }}>Precio por paquete {voucherPrice(row.product?.appliedPrice || 0)}</Typography>
                    <Typography sx={{ fontWeight: 800, fontSize: "1.05rem", flexShrink: 0 }}>{row.financials ? money(row.financials.salesTotal) : "—"}</Typography>
                  </Box>
                  <Box sx={{ display: "grid", gap: 0.75, p: 1.25, borderRadius: "16px", bgcolor: "#F3F7FE", border: "1.5px solid #1A56DB", minWidth: 0 }}>
                    {row.available != null ? (
                      <Typography sx={{ fontWeight: 700, fontSize: "0.875rem", lineHeight: 1.3, color: row.available > 0 ? "#0D652D" : "#8D4E00" }}>
                        Máximo disponible: {qty(row.available)}
                      </Typography>
                    ) : null}
                    <Typography component="label" sx={{ display: "block", color: "#1A56DB", fontWeight: 700, fontSize: "1rem", lineHeight: 1.3 }}>
                      Cantidad de paquetes
                    </Typography>
                    <NumericField
                      label="Cantidad de paquetes"
                      placeholder="Introduce la cantidad"
                      kind="packages"
                      size="medium"
                      value={row.quantity}
                      maximum={row.available == null ? undefined : Math.max(0, row.available)}
                      disabled={saving}
                      onCommit={(value) => updateQuantity(line.id, row.available, value)}
                      adornment={<Inventory2OutlinedIcon sx={{ color: "#1A56DB" }} />}
                      adornmentPosition="start"
                      sx={{
                        "& .MuiOutlinedInput-root": {
                          bgcolor: "#FFFFFF",
                          minHeight: 56,
                          "& fieldset": { borderColor: "#1A56DB", borderWidth: "1.5px" },
                          "&:hover fieldset": { borderColor: "#1A56DB" },
                          "&:focus-within fieldset, &.Mui-focused fieldset": { borderColor: "#1A56DB", borderWidth: "2px" },
                          "&.Mui-error fieldset": { borderColor: "#A50E0E", borderWidth: "2px" },
                        },
                        "& .MuiInputLabel-root": { position: "absolute", width: "1px", height: "1px", padding: 0, margin: "-1px", overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 },
                        "& .MuiOutlinedInput-notchedOutline legend": { maxWidth: "0.01px" },
                        "& .MuiInputBase-input": { fontSize: "1.25rem", fontWeight: 700 },
                        "& .MuiFormHelperText-root": { mx: 0, fontSize: "0.875rem" },
                        "& .MuiFormHelperText-root.Mui-error": { color: "#A50E0E", bgcolor: "#FCE8E6", borderRadius: "8px", px: 1, py: 0.75 },
                      }}
                    />
                    {row.message ? <Notice tone="warning">{row.message}</Notice> : null}
                  </Box>
                </Box>
              );
            })}
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
        <DialogActions
          sx={{
            px: 2,
            pt: 1,
            pb: "calc(12px + env(safe-area-inset-bottom))",
            display: "grid",
            columnGap: 1,
            rowGap: 1,
            gridTemplateColumns: narrow ? "1fr 1fr" : "auto auto auto",
            justifyContent: narrow ? "stretch" : "flex-end",
            "& .MuiButton-root": { minHeight: 44, m: "0 !important", whiteSpace: "nowrap", px: 1.5 },
          }}
        >
          <Button variant="outlined" onClick={() => { if (!saving) setConfirming(false); }} disabled={saving}>Volver a editar</Button>
          <Button color="error" onClick={discardSale} disabled={saving}>Cancelar</Button>
          <Button
            variant="contained"
            onClick={() => void confirm()}
            disabled={saving || !review.ok || !!registeredId}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : undefined}
            sx={{ gridColumn: narrow ? "1 / -1" : "auto" }}
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
