// firebase.ts
import { initializeApp } from "firebase/app";
import { getFirestore, enableIndexedDbPersistence } from "firebase/firestore";
import { getAuth } from "firebase/auth";

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
