import { useMediaQuery } from "@mui/material";

export function useNarrowScreen(): boolean {
  return useMediaQuery("(max-width: 767px)", { noSsr: true });
}

export function useDesktopScreen(): boolean {
  return useMediaQuery("(min-width: 1024px)", { noSsr: true });
}

export const upTablet = "@media (min-width: 768px)";
export const upDesktop = "@media (min-width: 1024px)";

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
