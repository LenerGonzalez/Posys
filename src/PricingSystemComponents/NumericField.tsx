import { useState, type ReactNode } from "react";
import { InputAdornment, TextField, type SxProps } from "@mui/material";
import {
  parseNumericDraft,
  reviewNumericBlur,
  reviewNumericChange,
  type NumericKind,
} from "./fieldValidation";

export default function NumericField({
  label,
  value,
  kind,
  onCommit,
  helperText,
  disabled,
  placeholder,
  adornment,
  adornmentPosition = "end",
  maximum,
  clearWhenEmpty,
  size,
  sx,
  labelShrink,
}: {
  label?: string;
  value: number | null;
  kind: NumericKind;
  onCommit: (value: number | null) => void;
  helperText?: string;
  disabled?: boolean;
  placeholder?: string;
  adornment?: ReactNode;
  adornmentPosition?: "start" | "end";
  maximum?: number;
  clearWhenEmpty?: boolean;
  size?: "small" | "medium";
  sx?: SxProps;
  labelShrink?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const storedText = value == null ? "" : String(value);
  const shown = draft ?? storedText;
  const storedParse = draft == null && storedText !== "" ? parseNumericDraft(storedText, kind) : null;
  const visibleError = error ?? (storedParse?.state === "invalid" ? storedParse.message : null);

  return (
    <TextField
      label={label}
      size={size}
      sx={sx}
      value={shown}
      disabled={disabled}
      placeholder={placeholder}
      error={Boolean(visibleError)}
      helperText={visibleError ?? helperText}
      onFocus={(event) => {
        setDraft(storedText);
        const target = event.target;
        const input =
          target instanceof HTMLInputElement ? target : event.currentTarget.querySelector("input");
        requestAnimationFrame(() => input?.select());
      }}
      onChange={(event) => {
        const reviewed = reviewNumericChange(value, draft ?? storedText, event.target.value, kind);
        if (clearWhenEmpty && reviewed.draft.trim() === "") {
          setDraft("");
          setError(null);
          onCommit(null);
          return;
        }
        if (maximum != null && reviewed.commit && reviewed.value != null && reviewed.value > maximum) {
          setError(maximum > 0 ? `Disponibles: ${maximum}.` : "No hay paquetes disponibles.");
          return;
        }
        setDraft(reviewed.draft);
        setError(reviewed.error);
        if (reviewed.commit) onCommit(reviewed.value);
      }}
      onBlur={() => {
        if (clearWhenEmpty && (draft ?? storedText).trim() === "") {
          setError(null);
          setDraft(null);
          onCommit(null);
          return;
        }
        const reviewed = reviewNumericBlur(value, draft ?? storedText, kind);
        if (maximum != null && reviewed.commit && reviewed.value != null && reviewed.value > maximum) {
          setError(maximum > 0 ? `Disponibles: ${maximum}.` : "No hay paquetes disponibles.");
          setDraft(null);
          return;
        }
        if (reviewed.commit) onCommit(reviewed.value);
        setError(reviewed.error);
        setDraft(null);
      }}
      slotProps={{
        inputLabel: labelShrink ? { shrink: true } : undefined,
        htmlInput: {
          inputMode: kind === "packages" ? "numeric" : "decimal",
          autoComplete: "off",
        },
        input: {
          startAdornment:
            adornment && adornmentPosition === "start" ? (
              <InputAdornment position="start">{adornment}</InputAdornment>
            ) : undefined,
          endAdornment:
            adornment && adornmentPosition === "end" ? (
              <InputAdornment position="end">{adornment}</InputAdornment>
            ) : undefined,
        },
      }}
    />
  );
}
