import { Box, MenuItem, TextField, ToggleButton, ToggleButtonGroup } from "@mui/material";
import { MEASURE_FILTER_OPTIONS, type MeasureFilter } from "./measureFilter";
import { useNarrowScreen } from "./screen";

export default function MeasureFilterField({
  value,
  onChange,
  variant = "select",
}: {
  value: MeasureFilter;
  onChange: (value: MeasureFilter) => void;
  variant?: "select" | "chips";
}) {
  const narrow = useNarrowScreen();
  if (variant === "chips" && !narrow) {
    return (
      <ToggleButtonGroup
        exclusive
        value={value}
        aria-label="Unidad"
        onChange={(_event, next: MeasureFilter | null) => {
          if (next) onChange(next);
        }}
        sx={{
          display: "flex",
          flexWrap: "wrap",
          gap: 1,
          "& .MuiToggleButtonGroup-grouped": {
            margin: 0,
            border: "1px solid rgba(26, 28, 30, 0.12) !important",
            borderRadius: "999px !important",
          },
        }}
      >
        {MEASURE_FILTER_OPTIONS.map((option) => (
          <ToggleButton
            key={option.value}
            value={option.value}
            sx={{
              px: 1.75,
              minHeight: 36,
              textTransform: "none",
              fontWeight: 700,
              color: "#3A4654",
              "&.Mui-selected": {
                bgcolor: "#E8F0FE",
                color: "#1A56DB",
                "&:hover": { bgcolor: "#E8F0FE" },
              },
            }}
          >
            {option.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    );
  }

  return (
    <Box sx={{ maxWidth: 240 }}>
      <TextField
        select
        fullWidth
        label="Unidad"
        value={value}
        onChange={(event) => onChange(event.target.value as MeasureFilter)}
      >
        {MEASURE_FILTER_OPTIONS.map((option) => (
          <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
        ))}
      </TextField>
    </Box>
  );
}
