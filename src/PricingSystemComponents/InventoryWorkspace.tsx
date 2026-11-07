import { useState } from "react";
import {
  AppBar,
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Tab,
  Tabs,
  TextField,
  Toolbar,
  Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import HistoryIcon from "@mui/icons-material/History";
import SaveIcon from "@mui/icons-material/Save";
import Comissions from "./Comissions";
import Dashboard from "./Dashboard";
import { dateTimeLabel, money } from "./format";
import { resolveCommissionMethod } from "./pricingEngine";
import { OrderProductsPanel } from "./MainInventory";
import PricesList from "./PricesList";
import Settings from "./Settings";
import { useNarrowScreen } from "./screen";
import type { ComputedInventory, PricingInventory, ProductInput } from "./types";

const TABS = ["Configuración", "OM - Productos", "Resumen", "Precios", "Utilidades"];

export default function InventoryWorkspace({
  inventory,
  computed,
  saving,
  dirty,
  onChange,
  onSave,
  onBack,
  onImportFile,
  onDownloadTemplate,
  onExport,
  initialTab = 0,
}: {
  inventory: PricingInventory;
  computed: ComputedInventory;
  saving: boolean;
  dirty: boolean;
  onChange: (inventory: PricingInventory) => void;
  onSave: () => void;
  onBack: () => void;
  onImportFile: (file: File) => void;
  onDownloadTemplate: () => void;
  onExport: () => void;
  initialTab?: number;
}) {
  const [tab, setTab] = useState(initialTab);
  const [historyOpen, setHistoryOpen] = useState(false);
  const narrow = useNarrowScreen();
  const [exporting, setExporting] = useState(false);
  const patchProduct = (id: string, patch: Partial<ProductInput>) => {
    onChange({
      ...inventory,
      products: inventory.products.map((product) =>
        product.id === id ? { ...product, ...patch } : product,
      ),
    });
  };

  return (
    <Box sx={{ display: "grid", gap: { xs: 1.25, md: 2 } }}>
      <AppBar position="static" color="inherit" elevation={0} sx={{ borderRadius: "16px", border: "1px solid", borderColor: "divider" }}>
        <Toolbar sx={{ gap: 0.75, flexWrap: "wrap", alignItems: "center", px: { xs: 1, sm: 2 }, py: { xs: 0.75, sm: 1 }, minHeight: { xs: 0, sm: 64 } }}>
          <IconButton aria-label="Volver" onClick={onBack}><ArrowBackIcon /></IconButton>
          <Box sx={{ flex: "1 1 200px", minWidth: 0, width: { xs: "calc(100% - 52px)", sm: "auto" } }}>
            <TextField
              label="Nombre del inventario"
              value={inventory.name}
              size="small"
              fullWidth
              error={!inventory.name.trim()}
              helperText={!inventory.name.trim() ? "Escribe un nombre." : undefined}
              onChange={(event) => onChange({ ...inventory, name: event.target.value })}
            />
            <Typography variant="caption" color="text.secondary">
              {dirty ? "Cambios sin guardar" : "Guardado"} · {dateTimeLabel(inventory.updatedAt)}
            </Typography>
          </Box>
          <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", width: { xs: "100%", sm: "auto" }, "& .MuiButton-root": { minHeight: { xs: 32, md: 40 }, fontSize: { xs: "0.8125rem", md: "0.875rem" }, flex: { xs: "1 1 0", sm: "0 0 auto" }, px: { xs: 0.75, md: 2 } } }}>
          <Button startIcon={<HistoryIcon />} onClick={() => setHistoryOpen(true)}>Historial</Button>
          <Button
            startIcon={<FileDownloadIcon />}
            disabled={exporting}
            onClick={() => {
              if (exporting) return;
              setExporting(true);
              window.setTimeout(() => {
                try {
                  onExport();
                } finally {
                  setExporting(false);
                }
              }, 0);
            }}
          >
            {exporting ? "Generando…" : "Exportar Excel"}
          </Button>
          <Button variant="contained" startIcon={<SaveIcon />} disabled={!dirty || saving || !inventory.name.trim()} onClick={onSave}>
            {saving ? "Guardando" : "Guardar"}
          </Button>
          </Box>
        </Toolbar>
      </AppBar>
      <Tabs
        value={tab}
        onChange={(_event, value) => setTab(value)}
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
        sx={{ minHeight: { xs: 36, md: 48 }, "& .MuiTabs-flexContainer": { gap: 0.25 } }}
      >
        {TABS.map((label) => (
          <Tab key={label} label={label} />
        ))}
      </Tabs>
      <Box>
        {tab === 0 ? (
          <Settings
            settings={inventory.settings}
            onChange={(settings) => onChange({ ...inventory, settings })}
          />
        ) : null}
        {tab === 1 ? (
          <OrderProductsPanel
            inventory={inventory}
            lines={computed.lines}
            onChange={(products) => onChange({ ...inventory, products })}
            onImportFile={onImportFile}
            onDownloadTemplate={onDownloadTemplate}
          />
        ) : null}
        {tab === 2 ? <Dashboard totals={computed.totals} history={inventory.history} /> : null}
        {tab === 3 ? (
          <PricesList
            lines={computed.lines}
            products={inventory.products}
            commissionMethod={resolveCommissionMethod(inventory.settings.commissionMethod)}
            onChangeProduct={patchProduct}
          />
        ) : null}
        {tab === 4 ? (
          <Comissions
            lines={computed.lines}
            totals={computed.totals}
            products={inventory.products}
            onChangeProduct={patchProduct}
          />
        ) : null}
      </Box>
      <Dialog open={historyOpen} onClose={() => setHistoryOpen(false)} fullScreen={narrow} fullWidth maxWidth="sm">
        <DialogTitle sx={{ pt: narrow ? "calc(16px + env(safe-area-inset-top))" : undefined }}>Historial de este inventario</DialogTitle>
        <DialogContent>
          {[...inventory.history].reverse().map((item) => (
            <Box key={item.savedAt} sx={{ py: 1.25, borderBottom: "1px solid", borderColor: "divider" }}>
              <Typography variant="body2" sx={{ fontWeight: 700 }}>{dateTimeLabel(item.savedAt)}</Typography>
              <Typography variant="body2" color="text.secondary">
                {item.productCount} productos · venta {money(item.projectedSales)} · neta {money(item.investorNet)}
              </Typography>
            </Box>
          ))}
          {!inventory.history.length ? (
            <Typography variant="body2" color="text.secondary">Aún no hay guardados.</Typography>
          ) : null}
        </DialogContent>
      </Dialog>
    </Box>
  );
}
