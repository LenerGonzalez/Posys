import { useEffect, useState } from "react";
import CloseIcon from "@mui/icons-material/Close";
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Typography,
} from "@mui/material";
import { PRICE_CATALOG_COLUMNS, PRICE_EXPORT_OPTIONAL_KEYS, type PriceExportColumnKey } from "./excelExport";

const OPTIONAL_COLUMNS = PRICE_CATALOG_COLUMNS.filter((column) => column.optional);
const LOCKED_COLUMNS = PRICE_CATALOG_COLUMNS.filter((column) => !column.optional);

export default function PriceExportDialog({
  open,
  narrow,
  exporting,
  productCount,
  onClose,
  onExport,
}: {
  open: boolean;
  narrow: boolean;
  exporting: boolean;
  productCount: number;
  onClose: () => void;
  onExport: (selected: PriceExportColumnKey[]) => void;
}) {
  const [selected, setSelected] = useState<PriceExportColumnKey[]>([]);

  useEffect(() => {
    if (open) setSelected([]);
  }, [open]);

  const toggle = (key: PriceExportColumnKey) => {
    setSelected((current) => (
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
    ));
  };

  const extraLabel = selected.length === 1
    ? "1 columna adicional seleccionada"
    : `${selected.length} columnas adicionales seleccionadas`;

  return (
    <Dialog
      open={open}
      onClose={exporting ? undefined : onClose}
      fullScreen={narrow}
      fullWidth
      maxWidth="sm"
      slotProps={{
        paper: {
          sx: {
            display: "flex",
            flexDirection: "column",
            borderRadius: narrow ? 0 : "20px",
            height: narrow ? "100%" : "auto",
            maxHeight: narrow ? "100%" : "min(720px, calc(100% - 64px))",
          },
        },
      }}
    >
      <DialogTitle
        sx={{
          display: "flex",
          alignItems: "flex-start",
          gap: 1,
          pr: 6,
          pt: narrow ? "calc(12px + env(safe-area-inset-top))" : 2,
          pb: 0.5,
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h6" sx={{ fontSize: "1.05rem", lineHeight: 1.25 }}>Exportar Excel</Typography>
          <Typography variant="body2" color="text.secondary">
            {productCount === 1 ? "1 producto" : `${productCount} productos`} según los filtros actuales.
          </Typography>
        </Box>
        <IconButton aria-label="Cerrar" onClick={onClose} disabled={exporting} sx={{ position: "absolute", right: 8, top: narrow ? "calc(8px + env(safe-area-inset-top))" : 8 }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 1, flex: "1 1 auto !important", minHeight: 0, overflow: "auto" }}>
        <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1, flexWrap: "wrap", alignItems: "center" }}>
          <Typography variant="caption" sx={{ fontWeight: 700, color: "#1A56DB" }}>{extraLabel}</Typography>
          <Box sx={{ display: "flex", gap: 0.5 }}>
            <Button size="small" onClick={() => setSelected(PRICE_EXPORT_OPTIONAL_KEYS)} disabled={exporting}>Seleccionar todas</Button>
            <Button size="small" onClick={() => setSelected([])} disabled={exporting}>Limpiar selección</Button>
          </Box>
        </Box>
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, columnGap: 1 }}>
          {LOCKED_COLUMNS.map((column) => (
            <FormControlLabel
              key={column.key}
              control={<Checkbox size="small" checked disabled />}
              label={
                <Typography variant="body2" sx={{ fontWeight: 700 }}>
                  {column.header}
                  <Typography component="span" variant="caption" color="text.secondary"> · Obligatoria</Typography>
                </Typography>
              }
              sx={{ mx: 0, minWidth: 0 }}
            />
          ))}
          {OPTIONAL_COLUMNS.map((column) => (
            <FormControlLabel
              key={column.key}
              control={(
                <Checkbox
                  size="small"
                  checked={selected.includes(column.key)}
                  onChange={() => toggle(column.key)}
                  disabled={exporting}
                />
              )}
              label={<Typography variant="body2">{column.header}</Typography>}
              sx={{ mx: 0, minWidth: 0 }}
            />
          ))}
        </Box>
      </DialogContent>
      <DialogActions
        sx={{
          px: 2,
          pt: 1.25,
          pb: "calc(16px + env(safe-area-inset-bottom))",
          gap: 1,
          borderTop: "1px solid rgba(26, 28, 30, 0.08)",
          "& .MuiButton-root": {
            minHeight: 44,
            "@media (max-width: 767px)": { flex: "1 1 0", marginLeft: 0 },
          },
        }}
      >
        <Button onClick={onClose} disabled={exporting}>Cancelar</Button>
        <Button variant="contained" disabled={exporting || productCount === 0} onClick={() => onExport(selected)}>
          {exporting ? "Generando…" : "Exportar Excel"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
