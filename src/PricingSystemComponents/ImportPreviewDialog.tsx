import CloseIcon from "@mui/icons-material/Close";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { money, qty } from "./format";
import type { ImportIssue, ImportPreview, ProductInput } from "./types";

const validTone = { background: "#E6F4EA", color: "#0D652D" };
const errorTone = { background: "#FCE8E6", color: "#A50E0E" };
const warningTone = { background: "#FEF4D6", color: "#8D4E00" };
const neutralTone = { background: "#E7EDF4", color: "#3A4654" };

function fileLevel(issue: ImportIssue): boolean {
  if (issue.row <= 0) return true;
  return (
    issue.message.startsWith("No se encontró la columna") ||
    issue.message.startsWith("Faltan columnas") ||
    issue.message.includes("no tiene hojas") ||
    issue.message.includes("no tiene productos")
  );
}

function Status({ kind }: { kind: "ok" | "error" | "warning" }) {
  const tone = kind === "ok" ? validTone : kind === "error" ? errorTone : warningTone;
  const label = kind === "ok" ? "Válido" : kind === "error" ? "Error" : "Advertencia";
  return (
    <Box
      component="span"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        px: 0.9,
        py: 0.25,
        borderRadius: "999px",
        bgcolor: tone.background,
        color: tone.color,
        fontSize: "0.75rem",
        fontWeight: 700,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </Box>
  );
}

function Indicator({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: { background: string; color: string };
}) {
  return (
    <Box sx={{ minWidth: 0, px: 1.15, py: 0.85, borderRadius: "12px", bgcolor: tone.background }}>
      <Typography variant="caption" sx={{ display: "block", color: tone.color, lineHeight: 1.2 }}>
        {label}
      </Typography>
      <Typography sx={{ mt: 0.15, fontWeight: 800, fontSize: "1.15rem", color: tone.color }}>
        {qty(value)}
      </Typography>
    </Box>
  );
}

function ProductCells({ product }: { product: ProductInput }) {
  return (
    <>
      <TableCell sx={{ fontWeight: 700 }}>{product.name}</TableCell>
      <TableCell>{product.orderCode || "Sin factura"}</TableCell>
      <TableCell align="right">{qty(product.packages)}</TableCell>
      <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>{money(product.costPerPack)}</TableCell>
      <TableCell><Status kind="ok" /></TableCell>
    </>
  );
}

function IssueCells({ issue }: { issue: ImportIssue }) {
  return (
    <>
      <TableCell>
        <Typography variant="body2" sx={{ fontWeight: 700, overflowWrap: "anywhere" }}>{issue.message}</Typography>
        {issue.row > 0 ? (
          <Typography variant="caption" color="text.secondary">Fila {issue.row}</Typography>
        ) : null}
      </TableCell>
      <TableCell>—</TableCell>
      <TableCell align="right">—</TableCell>
      <TableCell align="right">—</TableCell>
      <TableCell><Status kind={issue.level === "error" ? "error" : "warning"} /></TableCell>
    </>
  );
}

function ProductCard({ product }: { product: ProductInput }) {
  return (
    <Box sx={{ px: 1.25, py: 1, borderBottom: "1px solid", borderColor: "divider" }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1, alignItems: "flex-start" }}>
        <Typography sx={{ fontWeight: 700, overflowWrap: "anywhere" }}>{product.name}</Typography>
        <Status kind="ok" />
      </Box>
      <Typography variant="caption" color="text.secondary">{product.orderCode || "Sin factura"}</Typography>
      <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, mt: 0.6 }}>
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>Paquetes</Typography>
          <Typography sx={{ fontWeight: 700 }}>{qty(product.packages)}</Typography>
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>Costo por paquete</Typography>
          <Typography sx={{ fontWeight: 700 }}>{money(product.costPerPack)}</Typography>
        </Box>
      </Box>
    </Box>
  );
}

function IssueCard({ issue }: { issue: ImportIssue }) {
  return (
    <Box sx={{ px: 1.25, py: 1, borderBottom: "1px solid", borderColor: "divider" }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1, alignItems: "flex-start" }}>
        <Typography sx={{ fontWeight: 700, overflowWrap: "anywhere" }}>{issue.message}</Typography>
        <Status kind={issue.level === "error" ? "error" : "warning"} />
      </Box>
      {issue.row > 0 ? (
        <Typography variant="caption" color="text.secondary">Fila {issue.row}</Typography>
      ) : null}
    </Box>
  );
}

export default function ImportPreviewDialog({
  preview,
  narrow,
  onClose,
  onApply,
}: {
  preview: ImportPreview | null;
  narrow: boolean;
  onClose: () => void;
  onApply: () => void;
}) {
  const products = preview?.products ?? [];
  const issues = preview?.issues ?? [];
  const fileIssues = issues.filter(fileLevel);
  const rowErrors = issues.filter((issue) => issue.level === "error" && !fileLevel(issue));
  const warnings = issues.filter((issue) => issue.level === "warning");
  const detected = products.length + rowErrors.length;

  return (
    <Dialog
      open={!!preview}
      onClose={onClose}
      fullScreen={narrow}
      fullWidth
      maxWidth="md"
      slotProps={{
        paper: {
          sx: {
            display: "flex",
            flexDirection: "column",
            borderRadius: narrow ? 0 : "20px",
            height: narrow ? "100%" : "auto",
            maxHeight: narrow ? "100%" : "min(760px, calc(100% - 64px))",
          },
        },
      }}
    >
      <DialogTitle
        sx={{
          display: "flex",
          alignItems: "flex-start",
          gap: 1,
          px: { xs: 1.5, sm: 3 },
          pt: narrow ? "calc(12px + env(safe-area-inset-top))" : 2.5,
          pb: 1,
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6">Importar productos</Typography>
          <Typography variant="body2" color="text.secondary">
            Revisa los datos de la factura antes de incorporarlos al inventario.
          </Typography>
        </Box>
        <IconButton aria-label="Cerrar" onClick={onClose} sx={{ mt: -0.5 }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent
        sx={{
          display: "flex",
          flexDirection: "column",
          gap: 1.25,
          flex: "1 1 auto !important",
          minHeight: 0,
          overflow: "hidden",
          px: { xs: 1.5, sm: 3 },
          pt: "4px !important",
        }}
      >
        <Box
          sx={{
            display: "grid",
            gap: 0.75,
            gridTemplateColumns: {
              xs: "1fr 1fr",
              sm: warnings.length ? "repeat(4, minmax(0, 1fr))" : "repeat(3, minmax(0, 1fr))",
            },
            "& > :last-child:nth-of-type(odd)": { gridColumn: { xs: "1 / -1", sm: "auto" } },
          }}
        >
          <Indicator label="Filas detectadas" value={detected} tone={neutralTone} />
          <Indicator label="Productos válidos" value={products.length} tone={validTone} />
          <Indicator label="Filas con errores" value={rowErrors.length} tone={errorTone} />
          {warnings.length ? <Indicator label="Advertencias" value={warnings.length} tone={warningTone} /> : null}
        </Box>
        <Box sx={{ px: 1.25, py: 0.85, borderRadius: "12px", bgcolor: "#E8F0FE" }}>
          <Typography variant="body2" sx={{ color: "#1A56DB" }}>
            La configuración y los precios manuales existentes se conservan.
          </Typography>
        </Box>
        {fileIssues.map((issue) => (
          <Box key={`${issue.row}-${issue.message}`} sx={{ px: 1.25, py: 0.85, borderRadius: "12px", bgcolor: errorTone.background }}>
            <Typography variant="body2" sx={{ color: errorTone.color }}>{issue.message}</Typography>
          </Box>
        ))}
        {warnings.length ? (
          <Box sx={{ px: 1.25, py: 0.75, borderRadius: "12px", bgcolor: warningTone.background }}>
            <Typography variant="caption" sx={{ color: warningTone.color, display: "block", lineHeight: 1.35 }}>
              La advertencia no impide aplicar la importación. El aviso indica el producto repetido y que se incorporará otra línea.
            </Typography>
          </Box>
        ) : null}
        <Box
          sx={{
            flex: "0 1 auto",
            minHeight: 0,
            maxHeight: narrow ? "none" : "min(460px, calc(100vh - 340px))",
            overflow: "auto",
            border: "1px solid",
            borderColor: "divider",
            borderRadius: "14px",
          }}
        >
          {narrow ? (
            <Box>
              {rowErrors.map((issue) => <IssueCard key={`error-${issue.row}-${issue.message}`} issue={issue} />)}
              {warnings.map((issue) => <IssueCard key={`warning-${issue.row}-${issue.message}`} issue={issue} />)}
              {products.map((product) => <ProductCard key={product.id} product={product} />)}
              {!products.length && !rowErrors.length && !warnings.length ? (
                <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>No hay productos para mostrar.</Typography>
              ) : null}
            </Box>
          ) : (
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  {["Producto", "Factura", "Paquetes", "Costo por paquete", "Estado"].map((label) => (
                    <TableCell
                      key={label}
                      align={label === "Paquetes" || label === "Costo por paquete" ? "right" : "left"}
                      sx={{ bgcolor: "#F7F9FC", fontWeight: 700, whiteSpace: "nowrap" }}
                    >
                      {label}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {rowErrors.map((issue) => (
                  <TableRow key={`error-${issue.row}-${issue.message}`} hover>
                    <IssueCells issue={issue} />
                  </TableRow>
                ))}
                {warnings.map((issue) => (
                  <TableRow key={`warning-${issue.row}-${issue.message}`} hover>
                    <IssueCells issue={issue} />
                  </TableRow>
                ))}
                {products.map((product) => (
                  <TableRow key={product.id} hover sx={{ "& td": { borderColor: "divider" } }}>
                    <ProductCells product={product} />
                  </TableRow>
                ))}
                {!products.length && !rowErrors.length && !warnings.length ? (
                  <TableRow>
                    <TableCell colSpan={5}>
                      <Typography variant="body2" color="text.secondary">No hay productos para mostrar.</Typography>
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          )}
        </Box>
      </DialogContent>
      <DialogActions
        sx={{
          px: { xs: 1.5, sm: 3 },
          pt: 1.25,
          pb: "calc(16px + env(safe-area-inset-bottom))",
          gap: 1,
          justifyContent: "flex-end",
          borderTop: "1px solid",
          borderColor: "divider",
          bgcolor: "#FFFFFF",
          flexShrink: 0,
          "& .MuiButton-root": {
            minHeight: 44,
            "@media (max-width: 767px)": { flex: "1 1 0", marginLeft: "0 !important" },
          },
        }}
      >
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="contained" onClick={onApply} disabled={!products.length}>
          Aplicar importación
        </Button>
      </DialogActions>
    </Dialog>
  );
}
