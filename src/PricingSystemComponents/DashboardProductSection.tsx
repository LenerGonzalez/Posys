import { Fragment, useMemo, useState } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Card,
  CardContent,
  Collapse,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TableSortLabel,
  TextField,
  Typography,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { money, qty } from "./format";
import type { ProductReportRow } from "./dashboardReport";
import { upDesktop } from "./screen";

type SortKey = "productName" | "inventoryName" | "initialPackages" | "soldPackages" | "soldAllTime" | "availablePackages" | "salesTotal";

const PAGE_SIZES = [10, 25, 50];

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "es");
}

function compareNumber(left: number | null, right: number | null): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return left - right;
}

function sortValue(row: ProductReportRow, key: SortKey): string | number | null {
  if (key === "productName" || key === "inventoryName") return row[key];
  return row[key];
}

function availableTotal(rows: ProductReportRow[]): string {
  const known = rows.filter((row) => row.availablePackages != null);
  if (!known.length) return "sin dato de disponibles";
  const total = known.reduce((sum, row) => sum + (row.availablePackages ?? 0), 0);
  return `${qty(total)} ${total === 1 ? "paquete disponible" : "paquetes disponibles"}`;
}

function productCount(count: number): string {
  return `${qty(count)} ${count === 1 ? "producto" : "productos"}`;
}

function packageValue(value: number | null): string {
  return value == null ? "—" : qty(value);
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.2 }}>{label}</Typography>
      <Typography sx={{ fontWeight: 700, fontSize: "0.875rem", lineHeight: 1.25, overflowWrap: "anywhere" }}>{value}</Typography>
    </Box>
  );
}

function ProductCard({
  row,
  open,
  onToggle,
}: {
  row: ProductReportRow;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Card variant="outlined" sx={{ boxShadow: "none", borderColor: "rgba(26, 28, 30, 0.08)" }}>
      <CardContent sx={{ display: "grid", gap: 0.85, p: 1.25, "&:last-child": { pb: 1.25 } }}>
        <Typography sx={{ fontWeight: 800, fontSize: "0.95rem", lineHeight: 1.25, overflowWrap: "anywhere" }}>{row.productName}</Typography>
        <Box sx={{ display: "grid", gap: 0.75, gridTemplateColumns: "1fr 1fr" }}>
          <Fact label="Paquetes iniciales" value={packageValue(row.initialPackages)} />
          <Fact label="Vendidos en el período" value={qty(row.soldPackages)} />
          <Fact label="Vendidos acumulados" value={qty(row.soldAllTime)} />
          <Fact label="Disponibles ahora" value={packageValue(row.availablePackages)} />
        </Box>
        <Box sx={{ px: 1.1, py: 0.85, borderRadius: "12px", bgcolor: "#E6F4EA" }}>
          <Typography variant="caption" sx={{ color: "#0D652D", display: "block", lineHeight: 1.2 }}>Ventas del período</Typography>
          <Typography sx={{ fontWeight: 800, color: "#0D652D", fontSize: "1.05rem", lineHeight: 1.15 }}>{money(row.salesTotal)}</Typography>
        </Box>
        <Box
          component="button"
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 1,
            width: "100%",
            minHeight: 36,
            px: 0.25,
            border: 0,
            bgcolor: "transparent",
            color: "#1A56DB",
            cursor: "pointer",
          }}
        >
          <Typography sx={{ fontWeight: 700, fontSize: "0.8125rem", color: "#1A56DB" }}>{open ? "Ocultar detalle" : "Ver detalle"}</Typography>
          <ExpandMoreIcon sx={{ fontSize: 20, transform: open ? "rotate(180deg)" : "none", transition: "transform 160ms ease" }} />
        </Box>
        <Collapse in={open}>
          <Box sx={{ display: "grid", gap: 0.75, gridTemplateColumns: "1fr 1fr", pt: 0.25 }}>
            <Fact label="Factura" value={row.invoiceNumbers || "sin número"} />
            <Fact label="Ganancia del inversionista" value={money(row.investorNet)} />
            <Fact label="Ganancia del vendedor" value={money(row.vendorProfit)} />
            <Fact label="Comisión pagada" value={money(row.commissionPaid)} />
            <Fact label="Comisión pendiente" value={money(row.commissionPending)} />
          </Box>
        </Collapse>
      </CardContent>
    </Card>
  );
}

function InventoryGroups({ rows }: { rows: ProductReportRow[] }) {
  const [openInventory, setOpenInventory] = useState<string | null>(null);
  const [openProduct, setOpenProduct] = useState<string | null>(null);
  const groups = useMemo(() => {
    const map = new Map<string, ProductReportRow[]>();
    for (const row of rows) {
      const list = map.get(row.inventoryId) ?? [];
      list.push(row);
      map.set(row.inventoryId, list);
    }
    return [...map.entries()]
      .map(([id, products]) => ({
        id,
        name: products[0]?.inventoryName || "Inventario",
        products,
        salesTotal: products.reduce((sum, row) => sum + row.salesTotal, 0),
      }))
      .sort((left, right) => compareText(left.name, right.name));
  }, [rows]);

  return (
    <Box sx={{ display: "grid", gap: 1, [upDesktop]: { display: "none" } }}>
      {groups.map((group) => {
        const open = openInventory === group.id;
        return (
          <Accordion
            key={group.id}
            expanded={open}
            onChange={(_, expanded) => {
              setOpenInventory(expanded ? group.id : null);
              setOpenProduct(null);
            }}
            disableGutters
            elevation={0}
            sx={{
              border: "1px solid rgba(26, 28, 30, 0.08)",
              borderRadius: "12px !important",
              boxShadow: "0 1px 2px rgba(26, 28, 30, 0.04)",
              overflow: "hidden",
              "&:before": { display: "none" },
            }}
          >
            <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 1.25, "& .MuiAccordionSummary-content": { my: 1, minWidth: 0 } }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontWeight: 800, fontSize: "0.95rem", lineHeight: 1.25, overflowWrap: "anywhere" }}>{group.name}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
                  {productCount(group.products.length)} · {availableTotal(group.products)}
                </Typography>
                <Typography variant="body2" sx={{ fontWeight: 700, color: "#0D652D" }}>Ventas del período: {money(group.salesTotal)}</Typography>
                <Typography sx={{ fontWeight: 700, fontSize: "0.75rem", color: "#1A56DB", mt: 0.25 }}>{open ? "Ocultar" : "Ver productos"}</Typography>
              </Box>
            </AccordionSummary>
            <AccordionDetails sx={{ display: "grid", gap: 0.75, px: 1.25, pt: 0, pb: 1.25 }}>
              {group.products.map((row) => (
                <ProductCard
                  key={row.key}
                  row={row}
                  open={openProduct === row.key}
                  onToggle={() => setOpenProduct((current) => current === row.key ? null : row.key)}
                />
              ))}
            </AccordionDetails>
          </Accordion>
        );
      })}
    </Box>
  );
}

const COLUMNS: Array<{ key: SortKey; label: string; align: "left" | "right"; width: string }> = [
  { key: "productName", label: "Producto", align: "left", width: "20%" },
  { key: "inventoryName", label: "Inventario", align: "left", width: "16%" },
  { key: "initialPackages", label: "Iniciales", align: "right", width: "10%" },
  { key: "soldPackages", label: "En el período", align: "right", width: "12%" },
  { key: "soldAllTime", label: "Acumulados", align: "right", width: "12%" },
  { key: "availablePackages", label: "Disponibles", align: "right", width: "12%" },
  { key: "salesTotal", label: "Ventas", align: "right", width: "14%" },
];

function ProductTable({ rows }: { rows: ProductReportRow[] }) {
  const [query, setQuery] = useState("");
  const [inventoryId, setInventoryId] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({ key: "inventoryName", direction: "asc" });
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const inventories = useMemo(() => {
    const names = new Map<string, string>();
    for (const row of rows) names.set(row.inventoryId, row.inventoryName);
    return [...names.entries()].map(([id, name]) => ({ id, name })).sort((left, right) => compareText(left.name, right.name));
  }, [rows]);
  const visible = useMemo(() => {
    const text = query.trim().toLocaleLowerCase("es");
    const filtered = rows.filter((row) => {
      if (inventoryId && row.inventoryId !== inventoryId) return false;
      if (text && !row.productName.toLocaleLowerCase("es").includes(text)) return false;
      return true;
    });
    const direction = sort.direction === "asc" ? 1 : -1;
    filtered.sort((left, right) => {
      const result = typeof sortValue(left, sort.key) === "string"
        ? compareText(String(sortValue(left, sort.key)), String(sortValue(right, sort.key)))
        : compareNumber(sortValue(left, sort.key) as number | null, sortValue(right, sort.key) as number | null);
      return result * direction || compareText(left.inventoryName, right.inventoryName) || compareText(left.productName, right.productName);
    });
    return filtered;
  }, [rows, query, inventoryId, sort]);
  const pageCount = Math.max(1, Math.ceil(visible.length / rowsPerPage));
  const safePage = Math.min(page, pageCount - 1);
  const slice = visible.slice(safePage * rowsPerPage, safePage * rowsPerPage + rowsPerPage);

  const toggleSort = (key: SortKey) => {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: "asc" });
    setPage(0);
  };

  return (
    <Box sx={{ display: "none", gap: 1, [upDesktop]: { display: "grid" } }}>
      <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: "minmax(0, 1.4fr) minmax(180px, 0.8fr) auto", alignItems: "center" }}>
        <TextField
          label="Producto"
          placeholder="Buscar por nombre"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
        />
        <TextField
          select
          label="Inventario"
          value={inventories.some((item) => item.id === inventoryId) ? inventoryId : ""}
          onChange={(event) => {
            setInventoryId(event.target.value);
            setPage(0);
          }}
        >
          <MenuItem value="">Todos</MenuItem>
          {inventories.map((item) => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}
        </TextField>
        <Typography variant="body2" sx={{ fontWeight: 700, color: "#1A56DB", whiteSpace: "nowrap" }}>
          {visible.length} {visible.length === 1 ? "resultado" : "resultados"}
        </Typography>
      </Box>
      {!visible.length ? (
        <Typography variant="body2" color="text.secondary">Ningún producto coincide con la búsqueda.</Typography>
      ) : (
        <Box sx={{ border: "1px solid rgba(26, 28, 30, 0.08)", borderRadius: "12px", overflow: "hidden" }}>
        <TableContainer sx={{ maxHeight: 560 }}>
          <Table size="small" stickyHeader sx={{ tableLayout: "fixed", width: "100%" }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: "4%", bgcolor: "#F8F9FB", borderColor: "rgba(26, 28, 30, 0.08)" }} />
                {COLUMNS.map((column) => (
                  <TableCell
                    key={column.key}
                    align={column.align}
                    sx={{ width: column.width, bgcolor: "#F8F9FB", fontWeight: 600, fontSize: "0.8125rem", lineHeight: 1.25, whiteSpace: "normal", borderColor: "rgba(26, 28, 30, 0.08)" }}
                  >
                    <TableSortLabel
                      active={sort.key === column.key}
                      direction={sort.key === column.key ? sort.direction : "asc"}
                      onClick={() => toggleSort(column.key)}
                      sx={column.align === "right" ? { flexDirection: "row-reverse" } : undefined}
                    >
                      {column.label}
                    </TableSortLabel>
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {slice.map((row) => {
                const open = openKey === row.key;
                return (
                  <Fragment key={row.key}>
                    <TableRow
                      hover
                      sx={{ cursor: "pointer", bgcolor: open ? "#F8F9FB" : undefined }}
                      onClick={() => setOpenKey(open ? null : row.key)}
                    >
                      <TableCell sx={{ color: "#1A56DB", borderColor: "rgba(26, 28, 30, 0.08)" }}>
                        <ExpandMoreIcon sx={{ fontSize: 20, display: "block", transform: open ? "rotate(180deg)" : "none", transition: "transform 160ms ease" }} />
                      </TableCell>
                      <TableCell sx={{ fontWeight: 700, overflowWrap: "anywhere" }}>{row.productName}</TableCell>
                      <TableCell sx={{ overflowWrap: "anywhere" }}>{row.inventoryName}</TableCell>
                      <TableCell align="right">{packageValue(row.initialPackages)}</TableCell>
                      <TableCell align="right">{qty(row.soldPackages)}</TableCell>
                      <TableCell align="right">{qty(row.soldAllTime)}</TableCell>
                      <TableCell align="right">{packageValue(row.availablePackages)}</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 800, color: "#0D652D", bgcolor: "#F3FBF6", whiteSpace: "nowrap" }}>{money(row.salesTotal)}</TableCell>
                    </TableRow>
                    {open ? (
                      <TableRow key={`${row.key}-detalle`}>
                        <TableCell colSpan={8} sx={{ bgcolor: "#F8F9FB", py: 1.25 }}>
                          <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}>
                            <Fact label="Factura" value={row.invoiceNumbers || "sin número"} />
                            <Fact label="Ganancia del inversionista" value={money(row.investorNet)} />
                            <Fact label="Ganancia del vendedor" value={money(row.vendorProfit)} />
                            <Fact label="Comisión pagada" value={money(row.commissionPaid)} />
                            <Fact label="Comisión pendiente" value={money(row.commissionPending)} />
                          </Box>
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
          <TablePagination
            component="div"
            count={visible.length}
            page={safePage}
            rowsPerPage={rowsPerPage}
            rowsPerPageOptions={PAGE_SIZES}
            onPageChange={(_, next) => setPage(next)}
            onRowsPerPageChange={(event) => {
              setRowsPerPage(Number(event.target.value));
              setPage(0);
            }}
            labelRowsPerPage="Filas"
            labelDisplayedRows={({ from, to, count }) => `${from}–${to} de ${count}`}
          />
        </Box>
      )}
    </Box>
  );
}

export default function DashboardProductSection({ rows }: { rows: ProductReportRow[] }) {
  return (
    <>
      <InventoryGroups rows={rows} />
      <ProductTable rows={rows} />
    </>
  );
}
