import { useMediaQuery } from "@mui/material";

export function useNarrowScreen(): boolean {
  return useMediaQuery("(max-width: 767px)", { noSsr: true });
}

export function useDesktopScreen(): boolean {
  return useMediaQuery("(min-width: 1024px)", { noSsr: true });
}

export const upTablet = "@media (min-width: 768px)";
export const upDesktop = "@media (min-width: 1024px)";

export const dialogFormSx = {
  display: "grid",
  alignContent: "start",
  gridAutoRows: "min-content",
  gap: 1,
  pt: "8px !important",
} as const;

export const metricGridSx = {
  display: "grid",
  gap: { xs: 0, md: 2 },
  border: { xs: "1px solid rgba(26, 28, 30, 0.08)", md: "none" },
  borderRadius: { xs: "14px", md: 0 },
  overflow: "hidden",
  bgcolor: { xs: "#FFFFFF", md: "transparent" },
} as const;

export const metricCellSx = {
  minWidth: 0,
  px: { xs: 1.15, md: 2 },
  py: { xs: 0.85, md: 1.75 },
  bgcolor: { md: "#FFFFFF" },
  borderRadius: { md: "20px" },
  borderStyle: "solid",
  borderColor: "rgba(26, 28, 30, 0.08)",
  borderWidth: { xs: "0 0 1px 0", md: "1px" },
  boxShadow: { md: "0 1px 2px rgba(26, 28, 30, 0.06)" },
} as const;

export const dialogActionsSx = {
  px: 2,
  pt: 1,
  pb: "calc(16px + env(safe-area-inset-bottom))",
  gap: 1,
  flexWrap: "wrap",
  "& .MuiButton-root": {
    minHeight: 44,
    "@media (max-width: 767px)": { width: "100%", marginLeft: 0 },
  },
} as const;
