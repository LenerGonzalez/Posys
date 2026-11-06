import { Fragment, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import TuneOutlinedIcon from "@mui/icons-material/TuneOutlined";
import { money, percent, qty } from "./format";
import NumericField from "./NumericField";
import { computeInventory } from "./pricingEngine";
import {
  buildPriceRows,
  EMPTY_PRICE_FILTERS,
  filterPriceRows,
  previewProductPrice,
  priceDraftError,
  priceScopeOptions,
  type PriceDraft,
  type PriceFilters,
  type PriceRow,
} from "./priceCatalog";
import { dialogActionsSx, upDesktop, upTablet, useDesktopScreen, useNarrowScreen } from "./screen";
import type { ComputedLine, PriceMethod, PricingInventory } from "./types";

function entryLabel(method: PriceMethod, manual: number | null, margin: number | null, settingsMargin: number): string {
  if (method === "PRECIO") return manual != null && manual > 0 ? money(manual) : "Sin precio manual";
  return margin == null ? `Margen general ${percent(settingsMargin, 0)}` : percent(margin);
}

function invoiceLabel(orderCode: string): string {
  const code = orderCode.trim();
  if (!code) return "Sin factura";
  return /^factura\b/i.test(code) ? code : `Factura ${code}`;
}

function PriceFacts({ line, row }: { line: ComputedLine; row: PriceRow }) {
  const facts = [
    ["Producto", row.product],
    ["Paquetes", qty(line.packages)],
    ["Costo proveedor", money(line.costPerPack)],
    ["Logística / paquete", money(line.logisticsPerPack)],
    ["Precio costo", money(line.costPlusLogisticsPerPack)],
    ["Costo + logística total", money(line.purchaseSubtotal + line.logisticsAllocated)],
    ["Método", row.priceMethod],
    ["Precio manual", row.manualPrice != null && row.manualPrice > 0 ? money(row.manualPrice) : "—"],
    ["Margen objetivo", row.targetMarginPercent == null ? `General ${percent(row.settingsMarginPercent, 0)}` : percent(row.targetMarginPercent)],
    ["Precio de venta", money(row.price)],
    ["Margen real", percent(row.margin)],
    ["Venta total", money(line.salesTotal)],
  ];
  return (
    <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: "1fr 1fr", [upTablet]: { gridTemplateColumns: "1fr 1fr 1fr" } }}>
      {facts.map(([label, value]) => (
        <Box key={label} sx={{ minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.2 }}>{label}</Typography>
          <Typography sx={{ fontWeight: 700, overflowWrap: "anywhere", fontSize: "0.9rem" }}>{value}</Typography>
        </Box>
      ))}
    </Box>
  );
}

export default function PriceRanking({
  inventories,
  onSave,
}: {
  inventories: PricingInventory[];
  onSave: (inventoryId: string, productId: string, draft: PriceDraft) => Promise<void>;
}) {
  const rows = useMemo(() => buildPriceRows(inventories), [inventories]);
  const options = useMemo(() => priceScopeOptions(inventories), [inventories]);
  const [filters, setFilters] = useState<PriceFilters>(EMPTY_PRICE_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [openDetail, setOpenDetail] = useState<string | null>(null);
  const visible = useMemo(() => filterPriceRows(rows, filters), [rows, filters]);
  const narrow = useNarrowScreen();
  const desktop = useDesktopScreen();
  const lines = useMemo(() => {
    const map = new Map<string, ComputedLine>();
    inventories.forEach((inventory) => {
      computeInventory(inventory).lines.forEach((line) => {
        map.set(`${inventory.id}:${line.id}`, line);
      });
    });
    return map;
  }, [inventories]);
  const names = useMemo(() => new Map(inventories.map((inventory) => [inventory.id, inventory.name.trim() || "Sin nombre"])), [inventories]);
  const extraFilters = filters.scope !== "" || filters.minPrice != null || filters.maxPrice != null;
  const [editing, setEditing] = useState<PriceRow | null>(null);
  const [draft, setDraft] = useState<PriceDraft | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inventory = inventories.find((item) => item.id === editing?.inventoryId) ?? null;
  const preview = inventory && editing && draft ? previewProductPrice(inventory, editing.productId, draft) : null;
  const draftError = draft ? priceDraftError(draft) : null;
  const unchanged = editing && draft
    ? editing.priceMethod === draft.priceMethod &&
      editing.manualPrice === draft.manualPrice &&
      editing.targetMarginPercent === draft.targetMarginPercent
    : true;

  const openEdit = (row: PriceRow) => {
    setEditing(row);
    setDraft({
      priceMethod: row.priceMethod,
      manualPrice: row.manualPrice,
      targetMarginPercent: row.targetMarginPercent,
    });
    setConfirming(false);
    setError("");
  };

  const closeEdit = () => {
    if (saving) return;
    setEditing(null);
    setDraft(null);
    setConfirming(false);
    setError("");
  };

  const confirmSave = async () => {
    if (!editing || !draft || draftError) return;
    setSaving(true);
    setError("");
    try {
      await onSave(editing.inventoryId, editing.productId, draft);
      setSaving(false);
      setConfirming(false);
      setEditing(null);
      setDraft(null);
    } catch (caught) {
      setSaving(false);
      setConfirming(false);
      setError(caught instanceof Error ? caught.message : "No se pudo guardar el precio.");
    }
  };

  return (
    <Box sx={{ display: "grid", gap: 1.5, minWidth: 0 }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1, alignItems: "flex-start", flexWrap: "wrap" }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h5">Precios</Typography>
          <Typography variant="body2" color="text.secondary">
            Catálogo de precios de venta. Cada producto pertenece a un inventario y se edita sin modificar los demás.
          </Typography>
        </Box>
        <Box sx={{ px: 1.25, py: 0.6, borderRadius: "999px", bgcolor: "#E8F0FE", flexShrink: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 800, color: "#1A56DB" }}>
            {visible.length} {visible.length === 1 ? "producto" : "productos"}
          </Typography>
        </Box>
      </Box>
      <Card>
        <CardContent sx={{ display: "grid", gap: 1.25, p: { xs: 1.5, sm: 2 } }}>
          {desktop ? (
            <Box sx={{ display: "grid", gap: 1, alignItems: "center", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1.2fr) minmax(0, 0.8fr) minmax(0, 0.8fr) auto" }}>
              <TextField
                select
                fullWidth
                label="Inventario"
                value={filters.scope}
                onChange={(event) => setFilters((current) => ({ ...current, scope: event.target.value }))}
                sx={{ minWidth: 0 }}
              >
                {options.map((option) => (
                  <MenuItem key={option.value || "all"} value={option.value}>{option.label}</MenuItem>
                ))}
              </TextField>
              <TextField
                fullWidth
                label="Producto"
                value={filters.query}
                placeholder="Buscar por nombre"
                onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
                sx={{ minWidth: 0 }}
              />
              <NumericField
                label="Precio mínimo"
                kind="manualPrice"
                value={filters.minPrice}
                adornment="C$"
                adornmentPosition="start"
                sx={{ minWidth: 0, width: "100%" }}
                onCommit={(value) => setFilters((current) => ({ ...current, minPrice: value }))}
              />
              <NumericField
                label="Precio máximo"
                kind="manualPrice"
                value={filters.maxPrice}
                adornment="C$"
                adornmentPosition="start"
                sx={{ minWidth: 0, width: "100%" }}
                onCommit={(value) => setFilters((current) => ({ ...current, maxPrice: value }))}
              />
              <Button variant="text" onClick={() => setFilters(EMPTY_PRICE_FILTERS)} sx={{ minHeight: 44, whiteSpace: "nowrap" }}>
                Limpiar
              </Button>
            </Box>
          ) : (
            <>
              <TextField
                fullWidth
                label="Producto"
                value={filters.query}
                placeholder="Buscar por nombre"
                onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
              />
              <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
                <Button
                  variant={filtersOpen || extraFilters ? "contained" : "outlined"}
                  startIcon={<TuneOutlinedIcon />}
                  onClick={() => setFiltersOpen((current) => !current)}
                  aria-expanded={filtersOpen}
                  sx={{ minHeight: 44 }}
                >
                  Filtros
                </Button>
                {extraFilters ? (
                  <Typography variant="caption" color="text.secondary">Filtros activos</Typography>
                ) : null}
              </Box>
              <Collapse in={filtersOpen}>
                <Box sx={{ display: "grid", gap: 1.25, pt: 0.5 }}>
                  <TextField
                    select
                    fullWidth
                    label="Inventario"
                    value={filters.scope}
                    onChange={(event) => setFilters((current) => ({ ...current, scope: event.target.value }))}
                  >
                    {options.map((option) => (
                      <MenuItem key={option.value || "all"} value={option.value} sx={{ whiteSpace: "normal" }}>{option.label}</MenuItem>
                    ))}
                  </TextField>
                  <NumericField
                    label="Precio mínimo"
                    kind="manualPrice"
                    value={filters.minPrice}
                    adornment="C$"
                    adornmentPosition="start"
                    sx={{ width: "100%" }}
                    onCommit={(value) => setFilters((current) => ({ ...current, minPrice: value }))}
                  />
                  <NumericField
                    label="Precio máximo"
                    kind="manualPrice"
                    value={filters.maxPrice}
                    adornment="C$"
                    adornmentPosition="start"
                    sx={{ width: "100%" }}
                    onCommit={(value) => setFilters((current) => ({ ...current, maxPrice: value }))}
                  />
                  <Button variant="text" onClick={() => setFilters(EMPTY_PRICE_FILTERS)} sx={{ minHeight: 44, justifyContent: "flex-start" }}>
                    Limpiar filtros
                  </Button>
                </Box>
              </Collapse>
            </>
          )}
        </CardContent>
      </Card>
      {!rows.length ? (
        <Alert severity="info">Todavía no hay productos para mostrar.</Alert>
      ) : !visible.length ? (
        <Alert severity="info">Ningún producto coincide con los filtros.</Alert>
      ) : (
        <>
          <Box sx={{ display: "grid", gap: 1, [upDesktop]: { display: "none" } }}>
            {visible.map((row) => {
              const line = lines.get(row.id);
              const open = openDetail === row.id;
              return (
                <Card key={row.id} variant="outlined" sx={{ boxShadow: "0 1px 2px rgba(26, 28, 30, 0.04)" }}>
                  <CardContent sx={{ display: "grid", gap: 1.25, p: 1.75 }}>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography sx={{ fontWeight: 800, fontSize: "1.05rem", lineHeight: 1.25, overflowWrap: "anywhere" }}>{row.product}</Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
                        {names.get(row.inventoryId) || "Inventario"} · {invoiceLabel(row.orderCode)}
                      </Typography>
                    </Box>
                    <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1, alignItems: "center", px: 1.25, py: 1, borderRadius: "12px", bgcolor: "#E8F0FE" }}>
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="caption" sx={{ color: "#1A56DB", display: "block" }}>Precio de venta</Typography>
                        <Typography sx={{ fontWeight: 800, color: "#1A56DB", fontSize: "1.35rem", lineHeight: 1.1 }}>{money(row.price)}</Typography>
                      </Box>
                      <Box sx={{ px: 1.1, py: 0.45, borderRadius: "999px", bgcolor: "#FFFFFF", flexShrink: 0 }}>
                        <Typography variant="caption" sx={{ fontWeight: 800, color: "#0D652D" }}>Margen {percent(row.margin)}</Typography>
                      </Box>
                    </Box>
                    <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                      <Button variant="contained" startIcon={<EditOutlinedIcon />} onClick={() => openEdit(row)} aria-label={`Editar ${row.product} de ${row.origin}`} sx={{ minHeight: 44, flex: "1 1 140px" }}>
                        Editar
                      </Button>
                      {line ? (
                        <Button variant="text" onClick={() => setOpenDetail(open ? null : row.id)} aria-expanded={open} sx={{ minHeight: 44 }}>
                          {open ? "Ocultar detalle" : "Ver detalle"}
                        </Button>
                      ) : null}
                    </Box>
                    {line ? (
                      <Collapse in={open}>
                        <PriceFacts line={line} row={row} />
                      </Collapse>
                    ) : null}
                  </CardContent>
                </Card>
              );
            })}
          </Box>
          <Card sx={{ display: "none", [upDesktop]: { display: "block" }, overflow: "auto" }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  {["Inventario", "Factura", "Producto", "Precio de venta", "Margen", ""].map((label) => (
                    <TableCell key={label || "accion"} sx={{ fontWeight: 700, whiteSpace: "nowrap" }} align={label === "Precio de venta" || label === "Margen" ? "right" : "left"}>{label}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {visible.map((row) => {
                  const line = lines.get(row.id);
                  const open = openDetail === row.id;
                  return (
                    <Fragment key={row.id}>
                      <TableRow hover>
                        <TableCell sx={{ overflowWrap: "anywhere" }}>{names.get(row.inventoryId) || "Inventario"}</TableCell>
                        <TableCell sx={{ whiteSpace: "nowrap" }}>{invoiceLabel(row.orderCode)}</TableCell>
                        <TableCell sx={{ fontWeight: 700, overflowWrap: "anywhere" }}>{row.product}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 800, color: "#1A56DB", whiteSpace: "nowrap", fontSize: "1rem" }}>{money(row.price)}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700, color: "#0D652D", whiteSpace: "nowrap" }}>{percent(row.margin)}</TableCell>
                        <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                          {line ? (
                            <Button size="small" onClick={() => setOpenDetail(open ? null : row.id)} sx={{ minHeight: 40, mr: 0.5 }}>
                              {open ? "Ocultar" : "Detalle"}
                            </Button>
                          ) : null}
                          <Button size="small" variant="contained" startIcon={<EditOutlinedIcon />} onClick={() => openEdit(row)} aria-label={`Editar ${row.product} de ${row.origin}`} sx={{ minHeight: 40 }}>
                            Editar
                          </Button>
                        </TableCell>
                      </TableRow>
                      {open && line ? (
                        <TableRow key={`${row.id}-detalle`}>
                          <TableCell colSpan={6} sx={{ bgcolor: "#F8F9FB" }}>
                            <PriceFacts line={line} row={row} />
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        </>
      )}

      <Dialog open={Boolean(editing && draft)} onClose={closeEdit} fullScreen={narrow} fullWidth maxWidth="sm">
        <DialogTitle sx={{ pt: narrow ? "calc(16px + env(safe-area-inset-top))" : undefined }}>Editar precio</DialogTitle>
        <DialogContent sx={{ display: "grid", gap: 2, pt: 1 }}>
          {editing && draft && preview ? (
            <>
              <Box>
                <Typography variant="subtitle1">{editing.product}</Typography>
                <Typography variant="body2" color="text.secondary">{editing.origin}</Typography>
              </Box>
              <Box sx={{ display: "grid", gap: 0.5, p: 1.5, borderRadius: "12px", bgcolor: "#F8F9FA" }}>
                <Typography variant="caption" color="text.secondary">Valores actuales</Typography>
                <Typography variant="body2">Precio de venta {money(preview.before.appliedPrice)}</Typography>
                <Typography variant="body2">Método {editing.priceMethod}</Typography>
                <Typography variant="body2">
                  {editing.priceMethod === "MARGEN"
                    ? `Margen objetivo ${entryLabel("MARGEN", null, editing.targetMarginPercent, editing.settingsMarginPercent)}`
                    : `Precio manual ${entryLabel("PRECIO", editing.manualPrice, null, editing.settingsMarginPercent)}`}
                </Typography>
                <Typography variant="body2">Margen real {percent(preview.before.realMarginPercent)}</Typography>
              </Box>
              <TextField
                select
                label="Método de cálculo"
                value={draft.priceMethod}
                onChange={(event) => setDraft({ ...draft, priceMethod: event.target.value as PriceMethod })}
              >
                <MenuItem value="MARGEN">MARGEN</MenuItem>
                <MenuItem value="PRECIO">PRECIO</MenuItem>
              </TextField>
              {draft.priceMethod === "MARGEN" ? (
                <NumericField
                  label="Margen objetivo"
                  kind="optionalMargin"
                  value={draft.targetMarginPercent}
                  adornment="%"
                  placeholder="Usa el general"
                  helperText={draft.targetMarginPercent == null ? `Margen general de Configuración: ${percent(editing.settingsMarginPercent, 0)}` : "Este margen reemplaza al general."}
                  onCommit={(value) => setDraft((current) => current ? { ...current, targetMarginPercent: value } : current)}
                />
              ) : (
                <NumericField
                  label="Precio manual"
                  kind="manualPrice"
                  value={draft.manualPrice}
                  adornment="C$"
                  adornmentPosition="start"
                  helperText="Debe ser mayor que cero."
                  onCommit={(value) => setDraft((current) => current ? { ...current, manualPrice: value } : current)}
                />
              )}
              {draftError ? <Alert severity="warning">{draftError}</Alert> : (
                <Box sx={{ display: "grid", gap: 0.5, p: 1.5, borderRadius: "12px", bgcolor: "#E8F0FE" }}>
                  <Typography variant="caption" color="text.secondary">Resultado con el motor actual</Typography>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>Nuevo precio {money(preview.after.appliedPrice)}</Typography>
                  <Typography variant="body2">Margen real {percent(preview.after.realMarginPercent)}</Typography>
                </Box>
              )}
              {error ? <Alert severity="error">{error}</Alert> : null}
            </>
          ) : null}
        </DialogContent>
        <DialogActions sx={dialogActionsSx}>
          <Button onClick={closeEdit} disabled={saving}>Cancelar</Button>
          <Button variant="contained" disabled={Boolean(draftError) || unchanged || saving} onClick={() => setConfirming(true)}>
            Guardar
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={confirming} onClose={() => !saving && setConfirming(false)} fullScreen={narrow} fullWidth maxWidth="xs">
        <DialogTitle sx={{ pt: narrow ? "calc(16px + env(safe-area-inset-top))" : undefined }}>Confirmar cambio de precio</DialogTitle>
        <DialogContent sx={{ display: "grid", gap: 1 }}>
          {editing && draft && preview ? (
            <>
              <Typography variant="body2">{editing.product}</Typography>
              <Typography variant="body2" color="text.secondary">{editing.origin}</Typography>
              <Typography variant="body2">Método {editing.priceMethod} → {draft.priceMethod}</Typography>
              <Typography variant="body2">Precio {money(preview.before.appliedPrice)} → {money(preview.after.appliedPrice)}</Typography>
              <Typography variant="body2">Margen real {percent(preview.before.realMarginPercent)} → {percent(preview.after.realMarginPercent)}</Typography>
            </>
          ) : null}
        </DialogContent>
        <DialogActions sx={dialogActionsSx}>
          <Button onClick={() => setConfirming(false)} disabled={saving}>Cancelar</Button>
          <Button variant="contained" onClick={() => void confirmSave()} disabled={saving}>
            {saving ? "Guardando" : "Confirmar"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
