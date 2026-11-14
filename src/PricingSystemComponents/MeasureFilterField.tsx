import { MenuItem, TextField } from "@mui/material";
import { MEASURE_FILTER_OPTIONS, type MeasureFilter } from "./measureFilter";

export default function MeasureFilterField({
  value,
  onChange,
}: {
  value: MeasureFilter;
  onChange: (value: MeasureFilter) => void;
}) {
  return (
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
  );
}
