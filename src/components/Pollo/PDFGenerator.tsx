
import React from "react";

const PDFGenerator = () => {
  const generarPDF = () => {
    alert("PDF generado (simulado)");
  };

  return (
    <button onClick={generarPDF} className="bg-purple-600 text-white px-4 py-2 mt-4 rounded">
      Generar PDF
    </button>
  );
};

export default PDFGenerator;
