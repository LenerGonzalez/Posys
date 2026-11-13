import CloseIcon from "@mui/icons-material/Close";
import SellOutlinedIcon from "@mui/icons-material/SellOutlined";
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, MenuItem, TextField, Typography } from "@mui/material";
import { money, percent } from "./format";
import NumericField from "./NumericField";
import type { PriceDraft, PriceRow } from "./priceCatalog";
import type { ComputedLine, PriceMethod } from "./types";

function methodName(method: PriceMethod): string {
  return method === "PRECIO" ? "Precio manual" : "Margen objetivo";
}

function marginLabel(margin: number | null, settingsMargin: number): string {
  return margin == null ? `General ${percent(settingsMargin, 0)}` : percent(margin);
}

function priceDifference(before: number, after: number): { text: string; color: string } {
  if (money(before) === money(after)) return { text: money(0), color: "#44474E" };
  const delta = after - before;
  return {
    text: `${delta > 0 ? "+" : "−"}${money(Math.abs(delta))}`,
    color: delta > 0 ? "#0D652D" : "#A50E0E",
  };
}

const fieldSx = {
  "& .MuiInputBase-root": { fontSize: { xs: "15px", md: "16px" } },
  "& .MuiInputLabel-root": { fontSize: { xs: "14px", md: "15px" } },
  "& .MuiFormHelperText-root": { fontSize: { xs: "13px", md: "14px" }, lineHeight: 1.4, mt: 0.75 },
} as const;

function Fact({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography color="text.secondary" sx={{ display: "block", mb: 0.45, lineHeight: 1.3, fontSize: { xs: "13px", md: "14px" } }}>{label}</Typography>
      <Typography sx={{ fontWeight: 700, fontSize: { xs: "16px", md: "18px" }, lineHeight: 1.3, color: color || "#1A1C1E", overflowWrap: "anywhere" }}>{value}</Typography>
    </Box>
  );
}

export default function PriceEditDialog({
  open,
  narrow,
  inventoryName,
  row,
  draft,
  preview,
  draftError,
  error,
  unchanged,
  saving,
  onClose,
  onDraft,
  onSave,
}: {
  open: boolean;
  narrow: boolean;
  inventoryName: string;
  row: PriceRow | null;
  draft: PriceDraft | null;
  preview: { before: ComputedLine; after: ComputedLine } | null;
  draftError: string | null;
  error: string;
  unchanged: boolean;
  saving: boolean;
  onClose: () => void;
  onDraft: (draft: PriceDraft) => void;
  onSave: () => void;
}) {
  const ready = Boolean(row && draft && preview);
  const difference = preview ? priceDifference(preview.before.appliedPrice, preview.after.appliedPrice) : null;

  return (
    <Dialog
      open={open && ready}
      onClose={saving ? undefined : onClose}
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
            maxHeight: narrow ? "100%" : "min(820px, calc(100% - 64px))",
          },
        },
      }}
    >
      {row && draft && preview && difference ? (
        <>
          <DialogTitle
            sx={{
              display: "flex",
              alignItems: "flex-start",
              gap: 1.25,
              px: { xs: 2, sm: 3 },
              pr: 6,
              pt: narrow ? "calc(16px + env(safe-area-inset-top))" : 2.5,
              pb: 1.25,
            }}
          >
            <Box sx={{ width: 44, height: 44, borderRadius: "12px", bgcolor: "#E8F0FE", color: "#1A56DB", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <SellOutlinedIcon sx={{ fontSize: 24 }} />
            </Box>
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontWeight: 700, fontSize: { xs: "21px", md: "22px" }, lineHeight: 1.2 }}>Editar precio</Typography>
              <Typography sx={{ fontWeight: 800, fontSize: { xs: "17px", md: "18px" }, lineHeight: 1.3, overflowWrap: "anywhere" }}>{row.product}</Typography>
              <Typography color="text.secondary" sx={{ display: "block", fontSize: { xs: "14px", md: "15px" }, lineHeight: 1.35, overflowWrap: "anywhere" }}>{inventoryName}</Typography>
            </Box>
            <IconButton aria-label="Cerrar" onClick={onClose} disabled={saving} sx={{ position: "absolute", right: 8, top: narrow ? "calc(8px + env(safe-area-inset-top))" : 12 }}>
              <CloseIcon sx={{ fontSize: 24 }} />
            </IconButton>
          </DialogTitle>
          <DialogContent sx={{ display: "grid", alignContent: "start", gap: { xs: 1.75, md: 2.25 }, px: { xs: 2, sm: 3 }, flex: "1 1 auto !important", minHeight: 0, overflow: "auto" }}>
            <Box sx={{ display: "grid", gap: { xs: 1.35, md: 1.6 }, gridTemplateColumns: "1fr 1fr", p: { xs: 1.5, md: 2 }, borderRadius: "12px", bgcolor: "#F8F9FB" }}>
              <Fact label="Precio de venta actual" value={money(preview.before.appliedPrice)} color="#1A56DB" />
              <Fact label="Método de cálculo actual" value={methodName(row.priceMethod)} />
              {row.priceMethod === "PRECIO" ? (
                <Fact label="Precio manual actual" value={row.manualPrice != null && row.manualPrice > 0 ? money(row.manualPrice) : "Sin precio manual"} />
              ) : null}
              <Fact label="Margen objetivo actual" value={marginLabel(row.targetMarginPercent, row.settingsMarginPercent)} />
              <Fact label="Margen real actual" value={percent(preview.before.realMarginPercent)} color="#0D652D" />
            </Box>
            <TextField
              select
              size="medium"
              label="Método de cálculo"
              value={draft.priceMethod}
              helperText={draft.priceMethod === "PRECIO"
                ? "El precio manual reemplaza al precio automático."
                : "El margen objetivo calcula el precio de venta. Vacío usa el margen general."}
              sx={fieldSx}
              onChange={(event) => onDraft({ ...draft, priceMethod: event.target.value as PriceMethod })}
            >
              <MenuItem value="MARGEN" sx={{ fontSize: "16px", minHeight: 48 }}>Margen objetivo</MenuItem>
              <MenuItem value="PRECIO" sx={{ fontSize: "16px", minHeight: 48 }}>Precio manual</MenuItem>
            </TextField>
            {draft.priceMethod === "MARGEN" ? (
              <NumericField
                label="Margen objetivo"
                kind="optionalMargin"
                size="medium"
                value={draft.targetMarginPercent}
                adornment="%"
                placeholder="Usa el general"
                helperText={draft.targetMarginPercent == null ? `Margen general de Configuración: ${percent(row.settingsMarginPercent, 0)}` : "Este margen reemplaza al general."}
                sx={fieldSx}
                onCommit={(value) => onDraft({ ...draft, targetMarginPercent: value })}
              />
            ) : (
              <NumericField
                label="Precio manual"
                kind="manualPrice"
                size="medium"
                value={draft.manualPrice}
                adornment="C$"
                adornmentPosition="start"
                helperText="Debe ser mayor que cero. Este es el precio de venta que se aplica."
                sx={fieldSx}
                onCommit={(value) => onDraft({ ...draft, manualPrice: value })}
              />
            )}
            {draftError ? <Alert severity="warning" sx={{ fontSize: { xs: "14px", md: "15px" } }}>{draftError}</Alert> : (
              <Box sx={{ display: "grid", gap: { xs: 1.35, md: 1.6 }, gridTemplateColumns: "1fr 1fr", p: { xs: 1.5, md: 2 }, borderRadius: "12px", bgcolor: "#E8F0FE" }}>
                <Fact label="Precio de venta anterior" value={money(preview.before.appliedPrice)} />
                <Fact label="Nuevo precio calculado" value={money(preview.after.appliedPrice)} color="#1A56DB" />
                <Fact label="Margen real resultante" value={percent(preview.after.realMarginPercent)} color="#0D652D" />
                <Fact label="Diferencia" value={difference.text} color={difference.color} />
              </Box>
            )}
            {error ? <Alert severity="error" sx={{ fontSize: { xs: "14px", md: "15px" } }}>{error}</Alert> : null}
          </DialogContent>
          <DialogActions
            sx={{
              px: { xs: 2, sm: 3 },
              pt: 1.5,
              pb: "calc(16px + env(safe-area-inset-bottom))",
              gap: 1.25,
              borderTop: "1px solid rgba(26, 28, 30, 0.08)",
              "& .MuiButton-root": {
                minHeight: { xs: 48, md: 52 },
                fontSize: { xs: "15px", md: "16px" },
                fontWeight: 700,
                px: { xs: 1.5, md: 2.5 },
                whiteSpace: "nowrap",
                borderRadius: "12px",
                "@media (max-width: 767px)": { flex: "1 1 0", marginLeft: 0 },
              },
            }}
          >
            <Button variant="outlined" onClick={onClose} disabled={saving}>Cancelar</Button>
            <Button variant="contained" disabled={Boolean(draftError) || unchanged || saving} onClick={onSave}>
              Guardar cambios
            </Button>
          </DialogActions>
        </>
      ) : null}
    </Dialog>
  );
}
