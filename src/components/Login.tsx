// import React, { useState } from "react";
// import { signInWithEmailAndPassword } from "firebase/auth";
// import { auth } from "../firebase";
// 
// interface Props {
//   onLoginSuccess: () => void;
// }
// 
// export default function LoginForm({ onLoginSuccess }: Props) {
//   const [email, setEmail] = useState("");
//   const [password, setPassword] = useState("");
//   const [errorMsg, setErrorMsg] = useState("");
// 
//   const handleLogin = async (e: React.FormEvent) => {
//     e.preventDefault();
//     setErrorMsg("");
// 
//     try {
//       await signInWithEmailAndPassword(auth, email, password);
//       onLoginSuccess();
//     } catch (err) {
//       setErrorMsg("❌ Credenciales inválidas o error al iniciar sesión.");
//     }
//   };
// 
//   return (
//     <form
//       onSubmit={handleLogin}
//       className="max-w-sm mx-auto bg-white p-6 rounded shadow space-y-4"
//     >
//       <h2 className="text-xl font-bold">Iniciar Sesión</h2>
// 
//       <div>
//         <label className="block text-sm">Correo electrónico</label>
//         <input
//           type="email"
//           className="w-full border p-2 rounded"
//           value={email}
//           onChange={(e) => setEmail(e.target.value)}
//         />
//       </div>
// 
//       <div>
//         <label className="block text-sm">Contraseña</label>
//         <input
//           type="password"
//           className="w-full border p-2 rounded"
//           value={password}
//           onChange={(e) => setPassword(e.target.value)}
//         />
//       </div>
// 
//       <button
//         type="submit"
//         className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 w-full"
//       >
//         Ingresar
//       </button>
// 
//       {errorMsg && <p className="text-sm text-red-600">{errorMsg}</p>}
//     </form>
//   );
// }
// Login.tsx - Con manejo de roles desde Firestore
import React, { useState } from "react";
import { auth, db } from "../firebase";
import { signInWithEmailAndPassword } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { useNavigate } from "react-router-dom";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      const uid = userCredential.user.uid;

      const docRef = doc(db, "users", uid);
      const docSnap = await getDoc(docRef);

      if (docSnap.exists()) {
        const data = docSnap.data();
        const role = data.role;

        if (role === "admin") {
          navigate("/admin");
        } else if (role === "vendedor") {
          navigate("/ventas");
        } else {
          setError("Rol no válido");
        }
      } else {
        setError("No se encontró el perfil de usuario");
      }
    } catch (err: any) {
      console.error(err);
      setError("Credenciales incorrectas o error de conexión");
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-screen">
      <h1 className="text-2xl font-bold mb-4">Iniciar Sesión</h1>
      <form onSubmit={handleLogin} className="space-y-4 w-64">
        <input
          type="email"
          placeholder="Correo"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full p-2 border rounded"
          required
        />
        <input
          type="password"
          placeholder="Contraseña"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full p-2 border rounded"
          required
        />
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button
          type="submit"
          className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700"
        >
          Entrar
        </button>
      </form>
    </div>
  );
}
