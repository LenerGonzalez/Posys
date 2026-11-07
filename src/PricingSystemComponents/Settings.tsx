import { useState } from "react";
import {
  Box,
  Button,
  Card,
  CardContent,
  Collapse,
  FormControlLabel,
  Radio,
  RadioGroup,
  TextField,
  Typography,
} from "@mui/material";
import NumericField from "./NumericField";
import { resolveCommissionMethod } from "./pricingEngine";
import { useNarrowScreen } from "./screen";
import type { NumericKind } from "./fieldValidation";
import type { InventorySettings } from "./types";

const FIELDS: Array<{
  key: keyof Pick<
    InventorySettings,
    "logisticsCost" | "vendorSharePercent" | "targetMarginPercent"
  >;
  label: string;
  helper: string;
  adornment: string;
  position: "start" | "end";
  kind: NumericKind;
}> = [
  {
    key: "logisticsCost",
    label: "Gastos logísticos de la OM",
    helper: "Transporte, carga y almacenamiento de este inventario. Se prorratea por subtotal de compra.",
    adornment: "C$",
    position: "start",
    kind: "logistics",
  },
  {
    key: "vendorSharePercent",
    label: "Participación del vendedor",
    helper: "Porcentaje de comisión sobre la base del método elegido. Cada producto puede reemplazarlo.",
    adornment: "%",
    position: "end",
    kind: "commission",
  },
  {
    key: "targetMarginPercent",
    label: "Margen objetivo sobre costo + logística",
    helper: "Se aplica al costo por paquete más la logística asignada. El precio se redondea hacia arriba al córdoba siguiente.",
    adornment: "%",
    position: "end",
    kind: "margin",
  },
];

export default function Settings({
  settings,
  onChange,
}: {
  settings: InventorySettings;
  onChange: (settings: InventorySettings) => void;
}) {
  const method = resolveCommissionMethod(settings.commissionMethod);
  const narrow = useNarrowScreen();
  const [methodsOpen, setMethodsOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const methodCopy = (
    <>
      <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.4 }}>
        Opción 2. La comisión es la utilidad bruta por el porcentaje. La ganancia del inversionista antes de logística resta esa comisión, y la ganancia neta resta además la logística asignada.
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.4 }}>
        Opción 3. La base es la utilidad bruta menos la logística asignada, y la comisión es esa base por el porcentaje. Si la base es cero o negativa, la comisión queda en cero y el inversionista conserva ese resultado.
      </Typography>
    </>
  );
  const rules = (
    <Typography variant="body2" color="text.secondary" sx={{ display: "grid", gap: 0.75, lineHeight: 1.4 }}>
      <span>Prorrateo proporcional al subtotal de compra.</span>
      <span>La suma de la logística asignada coincide con el gasto configurado.</span>
      <span>El método elegido define la base de la comisión general y de la comisión individual de cada producto.</span>
      <span>El precio automático siempre redondea hacia arriba al córdoba entero.</span>
    </Typography>
  );
  return (
    <Box sx={{ display: "grid", gap: { xs: 1, md: 2 } }}>
      <Card>
        <CardContent sx={{ display: "grid", gap: 1 }}>
          <Box>
            <Typography variant="h6" sx={{ fontSize: { xs: "1rem", md: "1.25rem" } }}>Método de distribución de ganancias</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.4 }}>
              Esta elección pertenece solo a este inventario y recalcula comisiones y ganancias.
            </Typography>
          </Box>
          <RadioGroup
            value={method}
            onChange={(event) =>
              onChange({
                ...settings,
                commissionMethod: resolveCommissionMethod(event.target.value),
              })
            }
            sx={{ gap: 0.25 }}
          >
            <FormControlLabel
              value="2"
              control={<Radio size="small" />}
              label="Opción 2: Comisión sobre utilidad bruta."
            />
            <FormControlLabel
              value="3"
              control={<Radio size="small" />}
              label="Opción 3: Comisión sobre utilidad después de logística."
            />
          </RadioGroup>
          {narrow ? (
            <>
              <Button size="small" onClick={() => setMethodsOpen((current) => !current)} sx={{ justifyContent: "flex-start", px: 0, minHeight: 32 }}>
                {methodsOpen ? "Ocultar explicación" : "Ver cómo se calcula"}
              </Button>
              <Collapse in={methodsOpen}>
                <Box sx={{ display: "grid", gap: 0.75 }}>{methodCopy}</Box>
              </Collapse>
            </>
          ) : (
            <Box sx={{ display: "grid", gap: 1 }}>{methodCopy}</Box>
          )}
        </CardContent>
      </Card>
    <Box sx={{ display: "grid", gap: { xs: 1.25, md: 2 }, gridTemplateColumns: { xs: "1fr", md: "1.2fr 0.8fr" } }}>
      <Card>
        <CardContent sx={{ display: "grid", gap: { xs: 1, md: 2.5 } }}>
          <Box>
            <Typography variant="h6">Configuración del modelo</Typography>
            <Typography variant="body2" color="text.secondary">
              Estos valores pertenecen solo a este inventario.
            </Typography>
          </Box>
          {FIELDS.map((field) => (
            <NumericField
              key={field.key}
              label={field.label}
              kind={field.kind}
              value={settings[field.key]}
              helperText={field.helper}
              adornment={field.adornment}
              adornmentPosition={field.position}
              onCommit={(value) =>
                onChange({
                  ...settings,
                  [field.key]: value ?? 0,
                })
              }
            />
          ))}
          <TextField label="Sucursal / mercado" value={settings.branchLabel} disabled helperText="Este modelo usa una sola sucursal." />
        </CardContent>
      </Card>
      <Card>
        <CardContent sx={{ display: "grid", gap: 0.75 }}>
          <Typography variant="h6" sx={{ fontSize: { xs: "1rem", md: "1.25rem" } }}>
            Reglas fijas
          </Typography>
          {narrow ? (
            <>
              <Button size="small" onClick={() => setRulesOpen((current) => !current)} sx={{ justifyContent: "flex-start", px: 0, minHeight: 32 }}>
                {rulesOpen ? "Ocultar reglas" : "Ver reglas"}
              </Button>
              <Collapse in={rulesOpen}>{rules}</Collapse>
            </>
          ) : rules}
        </CardContent>
      </Card>
    </Box>
    </Box>
  );
}
