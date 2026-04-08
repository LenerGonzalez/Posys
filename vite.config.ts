import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      /** `prompt` para que `useRegisterSW().needRefresh` solo sea true con SW en espera (nueva build). */
      registerType: "prompt",
      injectRegister: "auto",
      /** En dev, desactivado: el SW puede interferir con subidas a Firebase Storage (XHR/fetch a googleapis.com). */
      devOptions: { enabled: false },

      includeAssets: [
        "favicon.ico",
        "apple-touch-icon.png",
        "logo_black.svg",
        "pwa-192x192.png",
        "pwa-512x512.png",
        "pwa-maskable-512x512.png",
      ],

      manifest: {
        name: "Posys",
        short_name: "Posys",
        description: "Sistema POS (Posys)",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        theme_color: "#ffffff",
        background_color: "#ffffff",
        icons: [
          {
            src: "/pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/pwa-maskable-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },

      workbox: {
        navigateFallback: "/index.html",
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        /** Con `registerType: "prompt"`, el SW nuevo queda en espera hasta «Actualizar». */
        clientsClaim: true,
        skipWaiting: false,
      },
    }),
  ],
  root: ".",
  publicDir: "public",
  build: { outDir: "dist" },
});
