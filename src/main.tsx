import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { initAuthPersistence } from "./firebase";
// Desactivado junto a OfflineOverlay: cualquier fetch fallido disparaba el aviso
// aunque hubiera internet (p. ej. pestaña en segundo plano, timeout).
// import { installFetchFailureOfflineHint } from "./utils/networkOffline";
// installFetchFailureOfflineHint();

// Esperamos a que la inicialización de persistencia de Auth termine
// (si falla, igual montamos la app pero ya tendremos el warning en consola).
initAuthPersistence
  .then((mode) => {
    console.info("Auth persistence mode:", mode);
  })
  .catch(() => {
    /* ignorar errores aquí: ya se loguean en firebase.ts */
  })
  .finally(() => {
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  });
