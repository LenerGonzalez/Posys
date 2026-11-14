import { useEffect, useMemo, useState } from "react";
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
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import TuneOutlinedIcon from "@mui/icons-material/TuneOutlined";
import { downloadPriceCatalog, type PriceExportColumnKey } from "./excelExport";
import { readSoldPackages } from "./firestoreSales";
import { stockKey } from "./saleCommit";
import { money, percent } from "./format";
import NumericField from "./NumericField";
import PriceDetailDialog from "./PriceDetailDialog";
import PriceEditDialog from "./PriceEditDialog";
import PriceExportDialog from "./PriceExportDialog";
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
import { dialogActionsSx, dialogFormSx, upDesktop, useDesktopScreen, useNarrowScreen } from "./screen";
import type { ComputedLine, PricingInventory } from "./types";

function invoiceLabel(orderCode: string): string {
  const code = orderCode.trim();
  if (!code) return "Sin factura";
  return /^factura\b/i.test(code) ? code : `Factura ${code}`;
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
  const [detailId, setDetailId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
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
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState("");
  const [soldByProduct, setSoldByProduct] = useState<Record<string, number>>({});
  const soldKey = inventories.map((inventory) => `${inventory.id}:${inventory.products.map((product) => product.id).join("|")}`).join(";");
  useEffect(() => {
    const keys = inventories.flatMap((inventory) => inventory.products.map((product) => ({ inventoryId: inventory.id, productId: product.id })));
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
  }, [soldKey]);
  const inventory = inventories.find((item) => item.id === editing?.inventoryId) ?? null;
  const preview = inventory && editing && draft ? previewProductPrice(inventory, editing.productId, draft) : null;
  const draftError = draft ? priceDraftError(draft) : null;
  const unchanged = editing && draft
    ? editing.priceMethod === draft.priceMethod &&
      editing.manualPrice === draft.manualPrice &&
      editing.targetMarginPercent === draft.targetMarginPercent
    : true;

  const filtersActive = filters.scope !== "" || filters.query.trim() !== "" || filters.minPrice != null || filters.maxPrice != null;
  const detailRow = rows.find((row) => row.id === detailId) ?? null;
  const detailLine = detailRow ? lines.get(detailRow.id) ?? null : null;
  const detailProduct = detailRow
    ? inventories.find((item) => item.id === detailRow.inventoryId)?.products.find((product) => product.id === detailRow.productId) ?? null
    : null;
  const detailCommission = detailProduct?.vendorSharePercent ?? null;

  const exportCatalog = async (selected: PriceExportColumnKey[]) => {
    if (exporting) return;
    const missing = visible.some((row) => !lines.has(row.id));
    if (missing) {
      setExportOpen(false);
      setExportNotice("No se pudo exportar porque falta el cálculo de algún producto.");
      return;
    }
    setExporting(true);
    setExportNotice("");
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      const filename = downloadPriceCatalog(visible.map((row) => ({
        inventoryName: names.get(row.inventoryId) || "Sin nombre",
        line: lines.get(row.id)!,
        manualPrice: row.manualPrice,
        productMargin: row.targetMarginPercent,
      })), new Date(), selected);
      const scope = filtersActive ? " Se exportaron solo los productos que coinciden con los filtros." : "";
      setExportNotice(`Se descargó ${filename}.${scope}`);
      setExportOpen(false);
    } catch (caught) {
      setExportNotice(caught instanceof Error ? caught.message : "No se pudo generar el Excel.");
    } finally {
      setExporting(false);
    }
  };

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
        <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
          <Button
            variant="outlined"
            size="small"
            startIcon={<FileDownloadOutlinedIcon />}
            disabled={exporting || visible.length === 0}
            onClick={() => setExportOpen(true)}
          >
            {exporting ? "Generando…" : "Exportar Excel"}
          </Button>
          <Box sx={{ px: 1.25, py: 0.6, borderRadius: "999px", bgcolor: "#E8F0FE", flexShrink: 0 }}>
            <Typography variant="body2" sx={{ fontWeight: 800, color: "#1A56DB" }}>
              {visible.length} {visible.length === 1 ? "producto" : "productos"}
            </Typography>
          </Box>
        </Box>
      </Box>
      {exportNotice ? (
        <Alert
          severity={exportNotice.startsWith("Se descargó") ? "success" : "error"}
          onClose={() => setExportNotice("")}
        >
          {exportNotice}
        </Alert>
      ) : null}
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
              <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "center" }}>
                <TextField
                  fullWidth
                  label="Producto"
                  value={filters.query}
                  placeholder="Buscar por nombre"
                  onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
                  sx={{ minWidth: 0 }}
                />
                <Button
                  variant={filtersOpen || extraFilters ? "contained" : "outlined"}
                  startIcon={<TuneOutlinedIcon />}
                  onClick={() => setFiltersOpen((current) => !current)}
                  aria-expanded={filtersOpen}
                  sx={{ minHeight: 40, px: 1.25, whiteSpace: "nowrap" }}
                >
                  Filtros
                </Button>
              </Box>
              {extraFilters ? (
                <Typography variant="caption" color="text.secondary">Filtros activos</Typography>
              ) : null}
              <Collapse in={filtersOpen}>
                <Box sx={{ display: "grid", gap: 1, pt: 0.25, gridTemplateColumns: "1fr 1fr", "& > :first-of-type": { gridColumn: "1 / -1" } }}>
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
              return (
                <Card key={row.id} variant="outlined" sx={{ boxShadow: "0 1px 2px rgba(26, 28, 30, 0.04)" }}>
                  <CardContent sx={{ display: "grid", gap: 0.75, p: 1.25 }}>
                    <Box sx={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 1 }}>
                      <Box sx={{ minWidth: 0 }}>
                        <Typography sx={{ fontWeight: 800, fontSize: "0.95rem", lineHeight: 1.25, overflowWrap: "anywhere" }}>{row.product}</Typography>
                        {line ? (
                          <Typography sx={{ display: "inline-flex", maxWidth: "100%", mt: 0.4, px: 0.9, py: 0.2, borderRadius: "999px", bgcolor: "#FEF4D6", color: "#8D4E00", fontWeight: 700, fontSize: "0.75rem", lineHeight: 1.35 }}>
                            Costo {money(line.costPerPack)}
                          </Typography>
                        ) : null}
                        {line ? (
                          <Typography sx={{ display: "block", mt: 0.4, color: "#6D4BA1", fontSize: "0.75rem", lineHeight: 1.25 }}>
                            U. Vendedor <Box component="span" sx={{ fontWeight: 800 }}>{money(line.vendorProfit)}</Box>
                          </Typography>
                        ) : null}
                      </Box>
                      <Box sx={{ textAlign: "right", flexShrink: 0 }}>
                        <Typography sx={{ fontWeight: 800, color: "#1A56DB", fontSize: "1.05rem", lineHeight: 1.15 }}>{money(row.price)}</Typography>
                        <Typography variant="caption" sx={{ fontWeight: 800, color: "#0D652D", display: "block" }}>Margen {percent(row.margin)}</Typography>
                        {line ? (
                          <Typography sx={{ display: "block", mt: 0.4, color: "#C05A12", fontSize: "0.75rem", lineHeight: 1.25 }}>
                            U. Inversor <Box component="span" sx={{ fontWeight: 800 }}>{money(line.investorNet)}</Box>
                          </Typography>
                        ) : null}
                      </Box>
                    </Box>
                    <Box sx={{ display: "grid", gap: 0.75, gridTemplateColumns: line ? "1fr 1fr" : "1fr" }}>
                      <Button size="small" variant="contained" startIcon={<EditOutlinedIcon />} onClick={() => openEdit(row)} aria-label={`Editar ${row.product} de ${row.origin}`} sx={{ minHeight: 36 }}>
                        Editar
                      </Button>
                      {line ? (
                        <Button size="small" variant="outlined" onClick={() => setDetailId(row.id)} sx={{ minHeight: 36 }}>
                          Ver detalle
                        </Button>
                      ) : null}
                    </Box>
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
                  return (
                    <TableRow key={row.id} hover>
                      <TableCell sx={{ overflowWrap: "anywhere" }}>{names.get(row.inventoryId) || "Inventario"}</TableCell>
                      <TableCell sx={{ whiteSpace: "nowrap" }}>{invoiceLabel(row.orderCode)}</TableCell>
                      <TableCell sx={{ fontWeight: 700, overflowWrap: "anywhere" }}>{row.product}</TableCell>
                      <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                        <Typography sx={{ fontWeight: 800, color: "#1A56DB", fontSize: "1rem", lineHeight: 1.15 }}>{money(row.price)}</Typography>
                        {line ? (
                          <Typography sx={{ display: "inline-flex", mt: 0.35, px: 0.9, py: 0.2, borderRadius: "999px", bgcolor: "#FEF4D6", color: "#8D4E00", fontWeight: 700, fontSize: "0.75rem", lineHeight: 1.35 }}>
                            Costo {money(line.costPerPack)}
                          </Typography>
                        ) : null}
                        {line ? (
                          <Typography sx={{ display: "block", mt: 0.35, color: "#6D4BA1", fontSize: "0.75rem", lineHeight: 1.25 }}>
                            U. Vendedor <Box component="span" sx={{ fontWeight: 800 }}>{money(line.vendorProfit)}</Box>
                          </Typography>
                        ) : null}
                      </TableCell>
                      <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                        <Typography sx={{ fontWeight: 700, color: "#0D652D", lineHeight: 1.15 }}>{percent(row.margin)}</Typography>
                        {line ? (
                          <Typography sx={{ display: "block", mt: 0.35, color: "#C05A12", fontSize: "0.75rem", lineHeight: 1.25 }}>
                            U. Inversor <Box component="span" sx={{ fontWeight: 800 }}>{money(line.investorNet)}</Box>
                          </Typography>
                        ) : null}
                      </TableCell>
                      <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                        {line ? (
                          <Button size="small" onClick={() => setDetailId(row.id)} sx={{ minHeight: 40, mr: 0.5 }}>
                            Detalle
                          </Button>
                        ) : null}
                        <Button size="small" variant="contained" startIcon={<EditOutlinedIcon />} onClick={() => openEdit(row)} aria-label={`Editar ${row.product} de ${row.origin}`} sx={{ minHeight: 40 }}>
                          Editar
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        </>
      )}

      <PriceExportDialog
        open={exportOpen}
        narrow={narrow}
        exporting={exporting}
        productCount={visible.length}
        onClose={() => setExportOpen(false)}
        onExport={(selected) => void exportCatalog(selected)}
      />
      <PriceDetailDialog
        open={Boolean(detailRow && detailLine)}
        narrow={narrow}
        productName={detailRow?.product || ""}
        inventoryName={detailRow ? names.get(detailRow.inventoryId) || "Inventario" : ""}
        line={detailLine}
        initialPackages={detailProduct?.packages ?? 0}
        soldPackages={detailRow ? soldByProduct[stockKey(detailRow.inventoryId, detailRow.productId)] || 0 : 0}
        manualCommission={detailCommission}
        onClose={() => setDetailId(null)}
      />
      <PriceEditDialog
        open={Boolean(editing && draft)}
        narrow={narrow}
        inventoryName={editing ? names.get(editing.inventoryId) || "Inventario" : ""}
        row={editing}
        draft={draft}
        preview={preview}
        draftError={draftError}
        error={error}
        unchanged={unchanged}
        saving={saving}
        onClose={closeEdit}
        onDraft={setDraft}
        onSave={() => setConfirming(true)}
      />

      <Dialog open={confirming} onClose={() => !saving && setConfirming(false)} fullScreen={narrow} fullWidth maxWidth="xs">
        <DialogTitle sx={{ pt: narrow ? "calc(16px + env(safe-area-inset-top))" : undefined }}>Confirmar cambio de precio</DialogTitle>
        <DialogContent sx={{ ...dialogFormSx, gap: 0.75 }}>
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
