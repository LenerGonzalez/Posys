import { createTheme } from "@mui/material/styles";

export const pricingTheme = createTheme({
  palette: {
    mode: "light",
    primary: { main: "#0B57D0", contrastText: "#FFFFFF" },
    secondary: { main: "#00639B" },
    error: { main: "#BA1A1A" },
    warning: { main: "#8D4E00" },
    success: { main: "#146C2E" },
    background: { default: "#F7F9FC", paper: "#FFFFFF" },
    text: { primary: "#1A1C1E", secondary: "#44474E" },
    divider: "rgba(26, 28, 30, 0.08)",
  },
  shape: { borderRadius: 16 },
  typography: {
    fontFamily: '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    h4: { fontWeight: 600, letterSpacing: -0.4 },
    h5: { fontWeight: 600, letterSpacing: -0.3 },
    h6: { fontWeight: 600 },
    subtitle2: { fontWeight: 600, letterSpacing: 0.2 },
    button: { fontWeight: 600, textTransform: "none" },
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: { borderRadius: 20, paddingInline: 16, boxShadow: "none" },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: "none" },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 20,
          border: "1px solid rgba(26, 28, 30, 0.08)",
          boxShadow: "0 1px 2px rgba(26, 28, 30, 0.06), 0 8px 24px rgba(26, 28, 30, 0.04)",
        },
      },
    },
    MuiTextField: {
      defaultProps: { size: "small", variant: "outlined" },
    },
    MuiOutlinedInput: {
      styleOverrides: { root: { borderRadius: 12 } },
    },
    MuiFormHelperText: {
      styleOverrides: {
        root: { marginTop: 3, lineHeight: 1.35 },
      },
    },
    MuiDialogContent: {
      styleOverrides: {
        root: {
          alignContent: "start",
          "@media (max-width: 899px)": {
            flex: "0 1 auto",
            minHeight: 0,
          },
        },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          textTransform: "none",
          fontWeight: 600,
          minHeight: 48,
          "@media (max-width: 899px)": {
            minHeight: 36,
            paddingTop: 6,
            paddingBottom: 6,
            fontSize: "0.8125rem",
          },
        },
      },
    },
  },
});
