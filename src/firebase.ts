// firebase.ts
import { initializeApp } from "firebase/app";
import { getFirestore, enableIndexedDbPersistence } from "firebase/firestore";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  indexedDBLocalPersistence,
  browserSessionPersistence,
} from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyA_ZzeP_DAoXeRuallrOaJ4xFaxjnuhw-8",
  authDomain: "posys-103de.firebaseapp.com",
  projectId: "posys-103de",
  storageBucket: "posys-103de.firebasestorage.app",
  messagingSenderId: "401054148688",
  appId: "1:401054148688:web:1c2aea9e8b40958b514955",
  measurementId: "G-Q2GWQXMFLX",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Intentar forzar persistencia local por defecto (mantener sesión al cerrar la app)
// Exportamos la promesa para que la app pueda esperar a que la persistencia
// se intente configurar antes de montar la UI.
export type PersistenceResult = "local" | "indexeddb" | "session" | "none";

export const initAuthPersistence: Promise<PersistenceResult> = (async () => {
  try {
    await setPersistence(auth, browserLocalPersistence);
    console.info("✅ Auth persistence: browserLocalPersistence enabled");
    return "local";
  } catch (errLocal) {
    console.warn(
      "⚠️ browserLocalPersistence failed:",
      (errLocal as any)?.code || errLocal,
    );
  }

  try {
    await setPersistence(auth, indexedDBLocalPersistence);
    console.info("✅ Auth persistence: indexedDBLocalPersistence enabled");
    return "indexeddb";
  } catch (errIndexed) {
    console.warn(
      "⚠️ indexedDBLocalPersistence failed:",
      (errIndexed as any)?.code || errIndexed,
    );
  }

  try {
    await setPersistence(auth, browserSessionPersistence);
    console.info(
      "ℹ️ Auth persistence: browserSessionPersistence enabled (session only)",
    );
    return "session";
  } catch (errSession) {
    console.warn(
      "⚠️ browserSessionPersistence failed:",
      (errSession as any)?.code || errSession,
    );
  }

  console.warn("❌ No se pudo establecer ninguna persistencia para Auth.");
  return "none";
})();

// 🔌 Activar persistencia offline
enableIndexedDbPersistence(db).catch((err) => {
  if (err.code === "failed-precondition") {
    console.warn("⚠️ Ya hay otra pestaña usando persistencia.");
  } else if (err.code === "unimplemented") {
    console.warn("⚠️ El navegador no soporta persistencia offline.");
  } else {
    console.error("❌ Error en persistencia offline:", err);
  }
});

export { db, auth };
