import { useEffect, useMemo, useState, type ReactNode } from "react";
import { v4 as uuid } from "uuid";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  TextField,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import LocalShippingOutlinedIcon from "@mui/icons-material/LocalShippingOutlined";
import PercentOutlinedIcon from "@mui/icons-material/PercentOutlined";
import PersonOutlineOutlinedIcon from "@mui/icons-material/PersonOutlineOutlined";
import ShoppingBagOutlinedIcon from "@mui/icons-material/ShoppingBagOutlined";
import ShoppingCartOutlinedIcon from "@mui/icons-material/ShoppingCartOutlined";
import ShowChartOutlinedIcon from "@mui/icons-material/ShowChartOutlined";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import TrendingUpOutlinedIcon from "@mui/icons-material/TrendingUpOutlined";
import AccountBalanceWalletOutlinedIcon from "@mui/icons-material/AccountBalanceWalletOutlined";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import DownloadIcon from "@mui/icons-material/Download";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import { parseNumericDraft, usableMoney, usablePackages } from "./fieldValidation";
import { readSoldPackages } from "./firestoreSales";
import { availablePackages, stockKey } from "./saleCommit";
import { dateTimeLabel, money, percent, qty } from "./format";
import { productProfitStatus, productStatusLabel } from "./productRanking";
import NumericField from "./NumericField";
import { dialogActionsSx, dialogFormSx, useNarrowScreen } from "./screen";
import type { ComputedLine, PricingInventory, ProductInput } from "./types";

function FileButton({
  label,
  onFile,
}: {
  label: ReactNode;
  onFile: (file: File) => void;
}) {
  return (
    <Button component="label" variant="contained" startIcon={<UploadFileIcon />}>
      {label}
      <input
        hidden
        type="file"
        accept=".xlsx,.xls"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onFile(file);
        }}
      />
    </Button>
  );
}

const sectionFieldSx = {
  "& .MuiInputBase-input": { fontSize: "1.125rem" },
  "& .MuiInputLabel-root": { fontSize: { xs: "1.125rem", md: "1.1875rem" } },
};

function Fact({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography color="text.secondary" sx={{ display: "block", lineHeight: 1.3, fontSize: { xs: "0.875rem", md: "0.9375rem" } }}>{label}</Typography>
      <Typography sx={{ fontWeight: 700, color: color || "text.primary", fontSize: "1.125rem", lineHeight: 1.3, overflowWrap: "anywhere" }}>{value}</Typography>
    </Box>
  );
}

function HighlightValue({ label, value, color, background }: { label: string; value: string; color: string; background: string }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography color="text.secondary" sx={{ display: "block", mb: 0.5, lineHeight: 1.3, fontSize: { xs: "0.875rem", md: "0.9375rem" } }}>{label}</Typography>
      <Box sx={{ display: "inline-flex", maxWidth: "100%", px: 1.25, py: 0.75, borderRadius: 999, bgcolor: background }}>
        <Typography sx={{ fontWeight: 700, color, fontSize: "1.1875rem", lineHeight: 1.2, overflowWrap: "anywhere" }}>{value}</Typography>
      </Box>
    </Box>
  );
}

function FactGrid({ children }: { children: ReactNode }) {
  return (
    <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr 1fr", md: "1fr 1fr 1fr" } }}>
      {children}
    </Box>
  );
}

function Metric({
  icon,
  label,
  value,
  detail,
  background,
  color,
  valueColor,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string;
  background: string;
  color: string;
  valueColor?: string;
}) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: { xs: 0.75, md: 1.25 }, minWidth: 0, px: { xs: 0.75, md: 1.5 }, py: { xs: 0.75, md: 1.25 }, borderRadius: { xs: "10px", md: 3 }, bgcolor: background }}>
      <Box sx={{ color, display: { xs: "none", sm: "flex" }, flexShrink: 0 }}>{icon}</Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="caption" sx={{ color, display: "block", lineHeight: 1.15 }}>{label}</Typography>
        <Typography sx={{ fontWeight: 700, fontSize: { xs: "0.92rem", md: "1.05rem" }, lineHeight: 1.25, color: valueColor || "text.primary", overflowWrap: "anywhere" }}>{value}</Typography>
        {detail ? (
          <Typography variant="caption" sx={{ color, display: "block", fontWeight: 700, lineHeight: 1.15 }}>{detail}</Typography>
        ) : null}
      </Box>
    </Box>
  );
}

function FinanceSection({
  title,
  icon,
  background,
  color,
  children,
}: {
  title: string;
  icon: ReactNode;
  background: string;
  color: string;
  children: ReactNode;
}) {
  return (
    <Box sx={{ minWidth: 0, p: { xs: 1.25, md: 1.75 }, borderRadius: { xs: "12px", md: 3 }, bgcolor: background }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: { xs: 1, md: 1.5 }, color }}>
        {icon}
        <Typography variant="subtitle2" sx={{ color, fontSize: "1.0625rem", lineHeight: 1.3 }}>{title}</Typography>
      </Box>
      {children}
    </Box>
  );
}

function ProductCard({
  product,
  line,
  soldPackages,
  onPatch,
  onRemove,
}: {
  product: ProductInput;
  line: ComputedLine | undefined;
  soldPackages: number;
  onPatch: (patch: Partial<ProductInput>) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [packageError, setPackageError] = useState("");
  const status = line ? productProfitStatus(line.investorNet, line.realMarginPercent) : null;
  const statusColor = status === "rentable" ? "#0D652D" : status === "perdida" || status === "margen_negativo" ? "#A50E0E" : "#8D4E00";
  const statusBackground = status === "rentable" ? "#E6F4EA" : status === "perdida" || status === "margen_negativo" ? "#FCE8E6" : "#FEF4D6";
  return (
    <Card variant="outlined" sx={{ boxShadow: "0 1px 2px rgba(26, 28, 30, 0.04)", borderColor: "rgba(26, 28, 30, 0.08)" }}>
      <CardContent sx={{ display: "grid", gap: { xs: 0.75, md: 1.75 }, p: { xs: 1.25, md: 2.25 } }}>
        <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1, flexWrap: "wrap" }}>
          <Box sx={{ width: 36, height: 36, borderRadius: "10px", bgcolor: "#E8F0FE", color: "#1A56DB", display: { xs: "none", md: "flex" }, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Inventory2OutlinedIcon fontSize="small" />
          </Box>
          <Box sx={{ flex: "1 1 160px", minWidth: 0 }}>
            <Typography variant="h6" title={product.name || "Sin nombre"} sx={{ fontSize: { xs: "0.98rem", md: "1.2rem" }, lineHeight: 1.25, overflowWrap: "anywhere" }}>
              {product.name || "Sin nombre"}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
              Orden: {product.orderCode || "Sin orden"}
            </Typography>
          </Box>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, ml: { sm: "auto" }, flexWrap: "wrap" }}>
            {status ? (
              <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, px: 1.25, py: 0.5, borderRadius: 999, bgcolor: statusBackground, color: statusColor }}>
                <TrendingUpOutlinedIcon sx={{ fontSize: 16 }} />
                <Typography variant="caption" sx={{ fontWeight: 700, color: statusColor }}>{productStatusLabel(status)}</Typography>
              </Box>
            ) : null}
            <IconButton aria-label="Quitar producto" onClick={onRemove} sx={{ border: "1px solid", borderColor: "divider", borderRadius: 2.5 }}>
              <DeleteOutlinedIcon fontSize="small" />
            </IconButton>
            <IconButton
              aria-label={open ? "Colapsar producto" : "Expandir producto"}
              aria-expanded={open}
              onClick={() => setOpen((current) => !current)}
              sx={{ border: "1px solid", borderColor: "divider", borderRadius: 2.5 }}
            >
              <ExpandMoreIcon sx={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
            </IconButton>
          </Box>
        </Box>
        {line ? (
          <Box sx={{ display: "grid", gap: 0.75 }}>
            <Box sx={{ display: "grid", gap: 0.75, gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
              <Metric icon={<StorageOutlinedIcon fontSize="small" />} label="Subtotal" value={money(line.purchaseSubtotal)} background="#E8F0FE" color="#1A56DB" />
              <Metric icon={<LocalShippingOutlinedIcon fontSize="small" />} label="Logística" value={money(line.logisticsAllocated)} background="#FEF4D6" color="#B06000" />
              <Metric icon={<ShoppingBagOutlinedIcon fontSize="small" />} label="Venta total" value={money(line.salesTotal)} background="#E6F4EA" color="#0D652D" />
              <Metric icon={<Inventory2OutlinedIcon fontSize="small" />} label="Paquetes iniciales" value={qty(product.packages)} background="#E7EDF4" color="#3A4654" />
              <Metric icon={<ShoppingCartOutlinedIcon fontSize="small" />} label="Vendidos" value={qty(soldPackages)} background="#F7F4FC" color="#6D4BA1" />
              <Metric icon={<Inventory2OutlinedIcon fontSize="small" />} label="Disponibles" value={qty(availablePackages(product.packages, soldPackages))} background="#E6F4EA" color="#0D652D" />
            </Box>
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
              <Box sx={{ display: "inline-flex", alignItems: "baseline", gap: 0.6, px: 1.1, py: 0.4, borderRadius: "999px", bgcolor: "#FEF4D6", color: "#8D4E00" }}>
                <Typography variant="caption" sx={{ fontWeight: 700, color: "#8D4E00" }}>Precio Costo</Typography>
                <Typography variant="caption" sx={{ fontWeight: 800, color: "#8D4E00" }}>{money(line.costPlusLogisticsPerPack)}</Typography>
              </Box>
              <Box sx={{ display: "inline-flex", alignItems: "baseline", gap: 0.6, px: 1.1, py: 0.4, borderRadius: "999px", bgcolor: "#E6F4EA", color: "#0D652D" }}>
                <Typography variant="caption" sx={{ fontWeight: 700, color: "#0D652D" }}>Precio Venta</Typography>
                <Typography variant="caption" sx={{ fontWeight: 800, color: "#0D652D" }}>{money(line.appliedPrice, 0)}</Typography>
              </Box>
            </Box>
            <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "1fr 1fr", md: "1fr 1fr 1fr 1fr" }, p: 1.25, borderRadius: "12px", bgcolor: "#F8F9FB" }}>
              <Metric icon={<ShowChartOutlinedIcon fontSize="small" />} label="Utilidad bruta" value={money(line.grossProfit)} detail={percent(line.systemGrossMarginPercent)} background="transparent" color="#1A1C1E" />
              <Metric icon={<PercentOutlinedIcon fontSize="small" />} label="Margen real" value={percent(line.realMarginPercent)} background="transparent" color="#0D652D" valueColor="#0D652D" />
              <Metric icon={<PersonOutlineOutlinedIcon fontSize="small" />} label="Ganancia vendedor" value={money(line.vendorProfit)} detail={percent(line.vendorSharePercent, 0)} background="transparent" color="#1A1C1E" />
              <Metric icon={<AccountBalanceWalletOutlinedIcon fontSize="small" />} label="Ganancia neta inversionista" value={money(line.investorNet)} background="transparent" color="#1A1C1E" />
            </Box>
          </Box>
        ) : (
          <Typography variant="caption" color="text.secondary">Completa el nombre para calcular esta línea.</Typography>
        )}
        <Collapse in={open}>
          <Box sx={{ display: "grid", gap: { xs: 1, md: 1.5 }, pt: 0.5 }}>
            <Box sx={{ display: "grid", gap: { xs: 1, md: 1.5 }, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}>
              <FinanceSection title="Compra y precios" icon={<ShoppingCartOutlinedIcon fontSize="small" />} background="#F3F7FE" color="#1A56DB">
                <Box sx={{ display: "grid", gap: 1, mb: 1.25, gridTemplateColumns: "1fr 1fr" }}>
                  <TextField label="Orden" value={product.orderCode} onChange={(event) => onPatch({ orderCode: event.target.value })} sx={sectionFieldSx} />
                  <TextField label="Producto" value={product.name} onChange={(event) => onPatch({ name: event.target.value })} sx={sectionFieldSx} />
                  <NumericField
                    label="Costo / paquete"
                    kind="cost"
                    value={product.costPerPack}
                    adornment="C$"
                    adornmentPosition="start"
                    onCommit={(value) => onPatch({ costPerPack: value ?? 0 })}
                    sx={sectionFieldSx}
                  />
                  <NumericField
                    label="Paquetes"
                    kind="packages"
                    value={product.packages}
                      sx={sectionFieldSx}
                      onCommit={(value) => {
                      if (value == null || value <= 0) return;
                      if (value < soldPackages) {
                        setPackageError(`Ya se vendieron ${qty(soldPackages)} paquetes. La cantidad mínima es ${qty(soldPackages)}.`);
                        return;
                      }
                      setPackageError("");
                      onPatch({ packages: value });
                    }}
                  />
                  {packageError ? (
                    <Typography sx={{ gridColumn: "1 / -1", color: "#A50E0E", fontSize: "1rem", lineHeight: 1.35 }}>{packageError}</Typography>
                  ) : soldPackages > 0 ? (
                    <Typography sx={{ gridColumn: "1 / -1", color: "text.secondary", fontSize: "0.875rem", lineHeight: 1.35 }}>
                      Vendidos: {qty(soldPackages)}. La cantidad no puede ser menor.
                    </Typography>
                  ) : null}
                </Box>
                {line ? (
                  <FactGrid>
                    <Fact label="Subtotal" value={money(line.purchaseSubtotal)} />
                    <Fact label="Precio automático / paquete" value={money(line.automaticPrice, 0)} />
                    <Fact label="Precio manual / paquete" value={line.manualPrice > 0 ? money(line.manualPrice, 0) : "—"} />
                    <Fact label="Precio de venta aplicado" value={money(line.appliedPrice, 0)} />
                    <Fact label="Margen real aplicado" value={percent(line.realMarginPercent)} color="#0D652D" />
                    <Fact label="Total de venta" value={money(line.salesTotal)} />
                  </FactGrid>
                ) : null}
              </FinanceSection>
              {line ? (
                <FinanceSection title="Rentabilidad" icon={<ShowChartOutlinedIcon fontSize="small" />} background="#F2FAF5" color="#0D652D">
                  <FactGrid>
                    <Fact label="Utilidad bruta total" value={money(line.grossProfit)} color="#0D652D" />
                    <Fact label="Utilidad bruta / paquete" value={money(line.grossProfitPerPack)} />
                    <Fact label="Margen bruto del sistema" value={percent(line.systemGrossMarginPercent)} color="#0D652D" />
                    <Fact label="Gasto logístico total" value={money(line.logisticsAllocated)} />
                    <Fact label="Gasto logístico / paquete" value={money(line.logisticsPerPack)} />
                  </FactGrid>
                </FinanceSection>
              ) : null}
              {line ? (
                <FinanceSection title="Ganancias del vendedor" icon={<PersonOutlineOutlinedIcon fontSize="small" />} background="#F7F4FC" color="#6D4BA1">
                  <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: "1fr 1fr" }}>
                    <Fact label="Comisión manual" value={product.vendorSharePercent == null ? "—" : percent(product.vendorSharePercent, 0)} />
                    <Fact label="Comisión aplicada" value={percent(line.vendorSharePercent, 0)} />
                    <HighlightValue label="Ganancia total del vendedor" value={money(line.vendorProfit)} color="#5B3D91" background="#E9E0F6" />
                    <HighlightValue label="Ganancia del vendedor / paquete" value={money(line.vendorProfitPerPack)} color="#5B3D91" background="#E9E0F6" />
                  </Box>
                </FinanceSection>
              ) : null}
              {line ? (
                <FinanceSection title="Ganancias del inversionista" icon={<AccountBalanceWalletOutlinedIcon fontSize="small" />} background="#FFF7F0" color="#C05A12">
                  <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: "1fr 1fr" }}>
                    <Fact label="Antes de logística" value={money(line.investorBeforeLogistics)} />
                    <Fact label="Antes de logística / paquete" value={money(line.investorBeforeLogisticsPerPack)} />
                    <HighlightValue label="Ganancia neta total" value={money(line.investorNet)} color="#C05A12" background="#FDE7D4" />
                    <HighlightValue label="Ganancia neta / paquete" value={money(line.investorNetPerPack)} color="#C05A12" background="#FDE7D4" />
                  </Box>
                </FinanceSection>
              ) : null}
            </Box>
          </Box>
        </Collapse>
      </CardContent>
    </Card>
  );
}

export function OrderProductsPanel({
  inventory,
  lines,
  onChange,
  onImportFile,
  onDownloadTemplate,
}: {
  inventory: PricingInventory;
  lines: ComputedLine[];
  onChange: (products: ProductInput[]) => void;
  onImportFile: (file: File) => void;
  onDownloadTemplate: () => void;
}) {
  const [search, setSearch] = useState("");
  const [draftOpen, setDraftOpen] = useState(false);
  const [draft, setDraft] = useState({ orderCode: "", name: "", costPerPack: 0, packages: 1 });
  const [draftError, setDraftError] = useState("");
  const [soldByProduct, setSoldByProduct] = useState<Record<string, number>>({});
  const narrow = useNarrowScreen();
  const lineById = new Map(lines.map((line) => [line.id, line]));
  const productIds = inventory.products.map((product) => product.id).join("|");
  useEffect(() => {
    const keys = inventory.products.map((product) => ({ inventoryId: inventory.id, productId: product.id }));
    if (!keys.length) {
      setSoldByProduct({});
      return;
    }
    let cancelled = false;
    void readSoldPackages(keys)
      .then((sold) => {
        if (!cancelled) setSoldByProduct(sold);
      })
      .catch(() => {
        if (!cancelled) setSoldByProduct({});
      });
    return () => {
      cancelled = true;
    };
  }, [inventory.id, productIds]);
  const filtered = inventory.products.filter((product) => {
    const query = search.trim().toLowerCase();
    if (!query) return true;
    return `${product.orderCode} ${product.name}`.toLowerCase().includes(query);
  });

  const patch = (id: string, partial: Partial<ProductInput>) => {
    onChange(
      inventory.products.map((product) => (product.id === id ? { ...product, ...partial } : product)),
    );
  };

  return (
    <Box sx={{ display: "grid", gap: { xs: 1.25, md: 2 } }}>
      <Paper
        variant="outlined"
        sx={{ p: { xs: 1.5, md: 2.5 }, borderStyle: "dashed", display: "flex", flexWrap: "wrap", gap: 1.25, alignItems: "center", justifyContent: "space-between" }}
      >
        <Box sx={{ display: "flex", gap: 1.5, alignItems: "center" }}>
          <UploadFileIcon color="primary" />
          <Box>
            <Typography variant="subtitle2">Importar factura</Typography>
            <Typography variant="body2" color="text.secondary">
              Actualiza costo y paquetes. No cambia precios manuales ni la configuración.
            </Typography>
          </Box>
        </Box>
        <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap", width: { xs: "100%", sm: "auto" }, "& .MuiButton-root": { minHeight: { xs: 32, md: 40 }, flex: { xs: "1 1 0", sm: "0 0 auto" }, px: { xs: 1, md: 2 } } }}>
          <Button variant="outlined" startIcon={<DownloadIcon />} onClick={onDownloadTemplate}>
            Plantilla
          </Button>
          <FileButton label="Importar Excel" onFile={onImportFile} />
        </Box>
      </Paper>
      <Box sx={{ display: "grid", gap: 0.75, gridTemplateColumns: { xs: "minmax(0, 1fr) auto", md: "minmax(0, 1fr) auto auto auto auto" }, alignItems: "center" }}>
        <TextField placeholder="Buscar producto u orden" value={search} onChange={(event) => setSearch(event.target.value)} sx={{ minWidth: 0 }} />
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => {
            setDraftError("");
            setDraftOpen(true);
          }}
          sx={{ minHeight: { xs: 32, md: 40 }, whiteSpace: "nowrap", px: { xs: 1.25, md: 2 } }}
        >
          Producto
        </Button>
        <Box sx={{ gridColumn: { xs: "1 / -1", md: "auto" }, display: "flex", gap: 0.5, flexWrap: "wrap", alignItems: "center" }}>
          <Chip size="small" label={`${qty(lines.length)} productos`} />
          <Chip size="small" label={`${qty(lines.reduce((sum, line) => sum + line.packages, 0))} paquetes`} />
          <Chip size="small" label={money(lines.reduce((sum, line) => sum + line.purchaseSubtotal, 0))} />
        </Box>
      </Box>
      <Box sx={{ display: "grid", gap: { xs: 0.75, md: 1.5 } }}>
        {filtered.map((product) => (
          <ProductCard
            key={product.id}
            product={product}
            line={lineById.get(product.id)}
            soldPackages={soldByProduct[stockKey(inventory.id, product.id)] || 0}
            onPatch={(partial) => patch(product.id, partial)}
            onRemove={() => onChange(inventory.products.filter((item) => item.id !== product.id))}
          />
        ))}
        {!filtered.length ? <Alert severity="info">Este inventario todavía no tiene productos.</Alert> : null}
      </Box>
      <Dialog open={draftOpen} onClose={() => setDraftOpen(false)} fullScreen={narrow} fullWidth maxWidth="xs">
        <DialogTitle sx={{ pt: narrow ? "calc(16px + env(safe-area-inset-top))" : undefined }}>Agregar producto</DialogTitle>
        <DialogContent sx={dialogFormSx}>
          <TextField label="Orden / factura" value={draft.orderCode} onChange={(event) => setDraft({ ...draft, orderCode: event.target.value })} />
          <TextField label="Producto" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: "1fr 1fr" }}>
            <NumericField
              label="Costo por paquete"
              kind="cost"
              value={draft.costPerPack}
              adornment="C$"
              adornmentPosition="start"
              onCommit={(value) => setDraft({ ...draft, costPerPack: value ?? 0 })}
            />
            <NumericField
              label="Paquetes"
              kind="packages"
              value={draft.packages}
              onCommit={(value) => {
                if (value != null && value > 0) setDraft({ ...draft, packages: value });
              }}
            />
          </Box>
          {draftError ? <Alert severity="error">{draftError}</Alert> : null}
        </DialogContent>
        <DialogActions sx={dialogActionsSx}>
          <Button onClick={() => setDraftOpen(false)}>Cancelar</Button>
          <Button
            variant="contained"
            onClick={() => {
              const cost = usableMoney(draft.costPerPack);
              const packages = usablePackages(draft.packages);
              if (!draft.name.trim()) {
                setDraftError("Escribe el nombre del producto.");
                return;
              }
              if (parseNumericDraft(String(draft.costPerPack), "cost").state !== "valid" || cost < 0) {
                setDraftError("El costo por paquete no puede ser negativo.");
                return;
              }
              if (packages <= 0) {
                setDraftError("La cantidad de paquetes debe ser un número entero mayor que cero.");
                return;
              }
              onChange([
                ...inventory.products,
                {
                  id: uuid(),
                  orderCode: draft.orderCode.trim(),
                  name: draft.name.trim(),
                  costPerPack: cost,
                  packages,
                  priceMethod: "MARGEN",
                  manualPrice: null,
                  targetMarginPercent: null,
                  vendorSharePercent: null,
                },
              ]);
              setDraft({ orderCode: "", name: "", costPerPack: 0, packages: 1 });
              setDraftError("");
              setDraftOpen(false);
            }}
          >
            Agregar
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default function MainInventory({
  inventories,
  loading,
  onOpen,
  onCreate,
  onRename,
  onDuplicate,
  onDelete,
  onImportFile,
  onDownloadTemplate,
}: {
  inventories: PricingInventory[];
  loading: boolean;
  onOpen: (inventory: PricingInventory) => void;
  onCreate: (name: string) => void;
  onRename: (inventory: PricingInventory, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onImportFile: (file: File) => void;
  onDownloadTemplate: () => void;
}) {
  const [name, setName] = useState("");
  const [renameName, setRenameName] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [renaming, setRenaming] = useState<PricingInventory | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PricingInventory | null>(null);
  const narrow = useNarrowScreen();

  return (
    <Box sx={{ display: "grid", gap: { xs: 1.25, md: 2 } }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", gap: 2, flexWrap: "wrap", alignItems: "center" }}>
        <Box>
          <Typography variant="h5">Inventarios</Typography>
          <Typography variant="body2" color="text.secondary">
            Cada inventario conserva su factura, configuración y resultados.
          </Typography>
        </Box>
        <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap", width: { xs: "100%", md: "auto" }, "& .MuiButton-root": { minHeight: { xs: 36, md: 44 }, flex: { xs: "1 1 0", md: "0 0 auto" }, px: { xs: 1, md: 2 } } }}>
          <Button variant="outlined" startIcon={<DownloadIcon />} onClick={onDownloadTemplate}>
            <Box component="span" sx={{ display: { xs: "none", md: "inline" } }}>Descargar </Box>plantilla
          </Button>
          <FileButton label={<><Box component="span" sx={{ display: { md: "none" } }}>Importar</Box><Box component="span" sx={{ display: { xs: "none", md: "inline" } }}>Importar factura</Box></>} onFile={onImportFile} />
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>
            Nuevo<Box component="span" sx={{ display: { xs: "none", md: "inline" } }}> inventario</Box>
          </Button>
        </Box>
      </Box>
      {loading ? <Alert severity="info">Cargando inventarios…</Alert> : null}
      {!loading && !inventories.length ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: "center" }}>
          <Inventory2OutlinedIcon color="primary" sx={{ fontSize: 40 }} />
          <Typography variant="h6" sx={{ mt: 1 }}>Todavía no hay inventarios</Typography>
          <Typography variant="body2" color="text.secondary">Crea uno o importa una factura Excel.</Typography>
        </Paper>
      ) : null}
      <Box sx={{ display: "grid", gap: { xs: 1.25, md: 2 }, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}>
        {inventories.map((inventory) => {
          const latest = inventory.history[inventory.history.length - 1];
          const invoices = [...new Set(inventory.products.map((product) => product.orderCode).filter(Boolean))];
          return (
            <Card key={inventory.id}>
              <CardContent sx={{ display: "grid", gap: { xs: 0.75, md: 1.25 } }}>
                <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1, alignItems: "flex-start" }}>
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 0.25, minWidth: 0 }}>
                      <Typography variant="h6" title={inventory.name} sx={{ fontSize: { xs: "1rem", md: "1.15rem" }, overflowWrap: "anywhere" }}>{inventory.name}</Typography>
                      <IconButton
                        aria-label={`Editar nombre de ${inventory.name}`}
                        size="small"
                        onClick={() => {
                          setRenaming(inventory);
                          setRenameName(inventory.name);
                        }}
                      >
                        <EditOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Box>
                    <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                      {qty(inventory.products.length)} productos{invoices.length ? ` · ${invoices.slice(0, 2).join(", ")}` : ""} · {dateTimeLabel(inventory.updatedAt)}
                    </Typography>
                  </Box>
                  <Button variant="contained" onClick={() => onOpen(inventory)} sx={{ minHeight: 36, flexShrink: 0, alignSelf: "center" }}>Abrir</Button>
                </Box>
                {latest ? (
                  <Box sx={{ display: "grid", gap: 0.75, gridTemplateColumns: "1fr 1fr" }}>
                    <Box sx={{ minWidth: 0, px: 1, py: 0.6, borderRadius: "10px", bgcolor: "#E8F0FE" }}>
                      <Typography variant="caption" sx={{ color: "#1A56DB", display: "block", lineHeight: 1.15 }}>Venta</Typography>
                      <Typography sx={{ fontWeight: 800, color: "#1A56DB", fontSize: "0.95rem", overflowWrap: "anywhere" }}>{money(latest.projectedSales)}</Typography>
                    </Box>
                    <Box sx={{ minWidth: 0, px: 1, py: 0.6, borderRadius: "10px", bgcolor: "#E6F4EA" }}>
                      <Typography variant="caption" sx={{ color: "#0D652D", display: "block", lineHeight: 1.15 }}>Neta</Typography>
                      <Typography sx={{ fontWeight: 800, color: "#0D652D", fontSize: "0.95rem", overflowWrap: "anywhere" }}>{money(latest.investorNet)}</Typography>
                    </Box>
                  </Box>
                ) : (
                  <Typography variant="caption" color="text.secondary">Sin guardados todavía.</Typography>
                )}
                <Box sx={{ display: "flex", gap: 0.5, justifyContent: "flex-end" }}>
                  <IconButton size="small" aria-label="Duplicar" onClick={() => onDuplicate(inventory.id)}><ContentCopyIcon fontSize="small" /></IconButton>
                  <IconButton size="small" aria-label="Eliminar" onClick={() => setPendingDelete(inventory)}><DeleteOutlinedIcon fontSize="small" /></IconButton>
                </Box>
              </CardContent>
            </Card>
          );
        })}
      </Box>
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullScreen={narrow} fullWidth maxWidth="xs">
        <DialogTitle sx={{ pt: narrow ? "calc(16px + env(safe-area-inset-top))" : undefined }}>Nuevo inventario</DialogTitle>
        <DialogContent>
          <TextField autoFocus fullWidth sx={{ mt: 1 }} label="Nombre" value={name} onChange={(event) => setName(event.target.value)} />
        </DialogContent>
        <DialogActions sx={dialogActionsSx}>
          <Button onClick={() => setCreateOpen(false)}>Cancelar</Button>
          <Button
            variant="contained"
            onClick={() => {
              if (!name.trim()) return;
              onCreate(name.trim());
              setName("");
              setCreateOpen(false);
            }}
          >
            Crear
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={!!renaming} onClose={() => setRenaming(null)} fullScreen={narrow} fullWidth maxWidth="xs">
        <DialogTitle sx={{ pt: narrow ? "calc(16px + env(safe-area-inset-top))" : undefined }}>Editar nombre</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            sx={{ mt: 1 }}
            label="Nombre del inventario"
            value={renameName}
            error={!!renaming && !renameName.trim()}
            helperText={renaming && !renameName.trim() ? "Escribe un nombre." : "Este nombre identifica el inventario en todo el módulo."}
            onChange={(event) => setRenameName(event.target.value)}
          />
        </DialogContent>
        <DialogActions sx={dialogActionsSx}>
          <Button onClick={() => setRenaming(null)}>Cancelar</Button>
          <Button
            variant="contained"
            disabled={!renaming || !renameName.trim() || renameName.trim() === renaming.name}
            onClick={() => {
              if (!renaming || !renameName.trim()) return;
              onRename(renaming, renameName.trim());
              setRenaming(null);
            }}
          >
            Guardar
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={!!pendingDelete} onClose={() => setPendingDelete(null)} fullScreen={narrow} fullWidth maxWidth="xs">
        <DialogTitle sx={{ pt: narrow ? "calc(16px + env(safe-area-inset-top))" : undefined }}>Eliminar inventario</DialogTitle>
        <DialogContent>
          <Typography>Se eliminará {pendingDelete?.name} y su historial. Esta acción no se deshace.</Typography>
        </DialogContent>
        <DialogActions sx={dialogActionsSx}>
          <Button onClick={() => setPendingDelete(null)}>Cancelar</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              if (pendingDelete) onDelete(pendingDelete.id);
              setPendingDelete(null);
            }}
          >
            Eliminar
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
