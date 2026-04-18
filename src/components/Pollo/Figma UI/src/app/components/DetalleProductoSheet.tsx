import { useState, useEffect } from 'react';
import { Drawer } from 'vaul';
import { Package } from 'lucide-react';
import type { Producto, ItemCarrito } from '../App';

interface DetalleProductoSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  producto: Producto | null;
  itemEditando: ItemCarrito | null;
  onAgregar: (libras: number, precioSugerido: number, descuento: number) => void;
}

export function DetalleProductoSheet({
  open,
  onOpenChange,
  producto,
  itemEditando,
  onAgregar
}: DetalleProductoSheetProps) {
  const [libras, setLibras] = useState('');
  const [precioSugerido, setPrecioSugerido] = useState('');
  const [descuento, setDescuento] = useState('');

  const esHuevos = producto?.nombre.toLowerCase() === 'huevos';

  useEffect(() => {
    if (itemEditando) {
      setLibras(itemEditando.libras.toString());
      setPrecioSugerido(itemEditando.precioSugerido.toString());
      setDescuento(itemEditando.descuento.toString());
    } else if (producto) {
      setLibras('');
      setPrecioSugerido(producto.precioBase.toString());
      setDescuento('0');
    }
  }, [producto, itemEditando]);

  const validarDecimales = (valor: string, maxDecimales: number) => {
    if (valor === '' || valor === '.') return valor;

    const valorLimpio = valor.replace(/,/g, '.');
    const regex = maxDecimales === 0
      ? /^\d*$/
      : new RegExp(`^\\d*\\.?\\d{0,${maxDecimales}}$`);

    if (regex.test(valorLimpio)) {
      return valorLimpio;
    }
    return valor.slice(0, -1);
  };

  const handleCantidadChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const maxDecimales = esHuevos ? 0 : 3;
    const valorValidado = validarDecimales(e.target.value, maxDecimales);
    setLibras(valorValidado);
  };

  const handlePrecioChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const valorValidado = validarDecimales(e.target.value, 2);
    setPrecioSugerido(valorValidado);
  };

  const handleDescuentoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const valorValidado = validarDecimales(e.target.value, 2);
    setDescuento(valorValidado);
  };

  const calcularTotal = () => {
    const l = parseFloat(libras) || 0;
    const p = parseFloat(precioSugerido) || 0;
    const d = parseFloat(descuento) || 0;
    return (l * p) * (1 - d / 100);
  };

  const handleAgregar = () => {
    const l = parseFloat(libras);
    const p = parseFloat(precioSugerido);
    const d = parseFloat(descuento);

    if (isNaN(l) || l <= 0) {
      alert(esHuevos ? 'Ingrese una cantidad válida' : 'Ingrese una cantidad de libras válida');
      return;
    }
    if (esHuevos && !Number.isInteger(l)) {
      alert('La cantidad de huevos debe ser un número entero');
      return;
    }
    if (isNaN(p) || p <= 0) {
      alert('Ingrese un precio sugerido válido');
      return;
    }
    if (isNaN(d) || d < 0 || d > 100) {
      alert('Ingrese un descuento válido (0-100)');
      return;
    }

    onAgregar(l, p, d);
    setLibras('');
    setPrecioSugerido('');
    setDescuento('0');
  };

  if (!producto) return null;

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/40" />
        <Drawer.Content className="bg-white flex flex-col rounded-t-[10px] h-[85%] mt-24 fixed bottom-0 left-0 right-0 max-w-md mx-auto">
          <div className="p-4 bg-white rounded-t-[10px] flex-1 flex flex-col">
            <div className="mx-auto w-12 h-1.5 flex-shrink-0 rounded-full bg-gray-300 mb-4" />
            <div className="max-w-md mx-auto w-full flex-1 flex flex-col">
              <Drawer.Title className="font-bold text-2xl mb-2">
                {itemEditando ? 'Editar Producto' : 'Agregar Producto'}
              </Drawer.Title>
              <Drawer.Description className="text-gray-600 mb-6">
                {itemEditando ? 'Modifica la cantidad, precio y descuento del producto' : 'Ingresa los detalles del producto a agregar'}
              </Drawer.Description>

              <div className="flex items-center gap-3 p-4 bg-blue-50 rounded-lg mb-6">
                <div className="p-2 bg-blue-600 rounded-full">
                  <Package className="w-6 h-6 text-white" />
                </div>
                <div>
                  <div className="font-semibold text-lg">{producto.nombre}</div>
                  <div className="text-sm text-gray-600">
                    Precio base: C${producto.precioBase.toFixed(2)}{esHuevos ? '/unidad' : '/lb'}
                  </div>
                </div>
              </div>

              <div className="space-y-4 flex-1">
                <div>
                  <label className="block text-sm font-semibold mb-2 text-gray-700">
                    {esHuevos ? 'Cantidad (Unidades)' : 'Cantidad (Libras)'}
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder={esHuevos ? '0' : '0.000'}
                    value={libras}
                    onChange={handleCantidadChange}
                    className="w-full px-4 py-3 text-lg border-2 border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold mb-2 text-gray-700">
                    {esHuevos ? 'Precio Sugerido (por unidad)' : 'Precio Sugerido (por libra)'}
                  </label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 transform -translate-y-1/2 text-lg text-gray-500">C$</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={precioSugerido}
                      onChange={handlePrecioChange}
                      className="w-full pl-12 pr-4 py-3 text-lg border-2 border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-semibold mb-2 text-gray-700">
                    Descuento (%)
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={descuento}
                      onChange={handleDescuentoChange}
                      className="w-full px-4 py-3 text-lg border-2 border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                    <span className="absolute right-4 top-1/2 transform -translate-y-1/2 text-lg text-gray-500">%</span>
                  </div>
                </div>

                <div className="p-4 bg-gradient-to-r from-green-50 to-green-100 rounded-lg border-2 border-green-300">
                  <div className="text-sm text-gray-600 mb-1">Subtotal</div>
                  <div className="text-3xl font-bold text-green-700">
                    C${calcularTotal().toFixed(2)}
                  </div>
                </div>
              </div>

              <div className="flex gap-3 mt-6">
                <button
                  onClick={() => onOpenChange(false)}
                  className="flex-1 py-3 border-2 border-gray-300 text-gray-700 rounded-lg font-semibold hover:bg-gray-50 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleAgregar}
                  className="flex-1 py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-colors"
                >
                  {itemEditando ? 'Actualizar' : 'Agregar'}
                </button>
              </div>
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
