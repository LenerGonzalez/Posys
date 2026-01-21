// firebase.ts
import { initializeApp } from "firebase/app";
import { getFirestore, enableIndexedDbPersistence } from "firebase/firestore";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
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
setPersistence(auth, browserLocalPersistence).catch((err) => {
  // Esto puede fallar en entornos sin soporte (e.g. some browsers/incognito)
  console.warn(
    "⚠️ No se pudo establecer persistencia local para Auth:",
    err?.code || err,
  );
});

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
