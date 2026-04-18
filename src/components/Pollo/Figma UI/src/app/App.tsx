import { useState } from 'react';
import { ShoppingCart, Plus, Trash2, Edit2, CreditCard, Wallet } from 'lucide-react';
import { TipoVentaSheet } from './components/TipoVentaSheet';
import { ClienteSheet } from './components/ClienteSheet';
import { ProductosSheet } from './components/ProductosSheet';
import { DetalleProductoSheet } from './components/DetalleProductoSheet';

export type TipoVenta = 'credito' | 'contado' | null;

export interface Cliente {
  id: string;
  nombre: string;
  telefono: string;
}

export interface Producto {
  id: string;
  nombre: string;
  precioBase: number;
  existencia: number;
  imagen: string;
}

export interface ItemCarrito {
  id: string;
  producto: Producto;
  libras: number;
  precioSugerido: number;
  descuento: number;
  subtotal: number;
}

export default function App() {
  const [tipoVenta, setTipoVenta] = useState<TipoVenta>(null);
  const [clienteSeleccionado, setClienteSeleccionado] = useState<Cliente | null>(null);
  const [carrito, setCarrito] = useState<ItemCarrito[]>([]);

  const [tipoVentaOpen, setTipoVentaOpen] = useState(false);
  const [clienteOpen, setClienteOpen] = useState(false);
  const [productosOpen, setProductosOpen] = useState(false);
  const [detalleProductoOpen, setDetalleProductoOpen] = useState(false);

  const [productoSeleccionado, setProductoSeleccionado] = useState<Producto | null>(null);
  const [itemEditando, setItemEditando] = useState<ItemCarrito | null>(null);

  const handleTipoVentaSelect = (tipo: 'credito' | 'contado') => {
    setTipoVenta(tipo);
    setTipoVentaOpen(false);

    if (tipo === 'credito') {
      setClienteOpen(true);
    } else {
      setClienteSeleccionado(null);
    }
  };

  const handleClienteSelect = (cliente: Cliente) => {
    setClienteSeleccionado(cliente);
    setClienteOpen(false);
  };

  const handleProductoSelect = (producto: Producto) => {
    setProductoSeleccionado(producto);
    setProductosOpen(false);
    setDetalleProductoOpen(true);
  };

  const handleAgregarProducto = (libras: number, precioSugerido: number, descuento: number) => {
    if (!productoSeleccionado) return;

    const subtotal = (libras * precioSugerido) * (1 - descuento / 100);

    if (itemEditando) {
      setCarrito(carrito.map(item =>
        item.id === itemEditando.id
          ? { ...item, libras, precioSugerido, descuento, subtotal }
          : item
      ));
      setItemEditando(null);
    } else {
      const nuevoItem: ItemCarrito = {
        id: Date.now().toString(),
        producto: productoSeleccionado,
        libras,
        precioSugerido,
        descuento,
        subtotal
      };
      setCarrito([...carrito, nuevoItem]);
    }

    setDetalleProductoOpen(false);
    setProductoSeleccionado(null);
  };

  const handleEditarItem = (item: ItemCarrito) => {
    setItemEditando(item);
    setProductoSeleccionado(item.producto);
    setDetalleProductoOpen(true);
  };

  const handleEliminarItem = (id: string) => {
    setCarrito(carrito.filter(item => item.id !== id));
  };

  const calcularTotal = () => {
    return carrito.reduce((sum, item) => sum + item.subtotal, 0);
  };

  const handleFinalizarVenta = () => {
    if (carrito.length === 0) {
      alert('El carrito está vacío');
      return;
    }

    if (tipoVenta === 'credito' && !clienteSeleccionado) {
      alert('Debe seleccionar un cliente para venta a crédito');
      return;
    }

    const mensaje = `Venta registrada:\nTipo: C${tipoVenta?.toUpperCase()}\nC${clienteSeleccionado ? `Cliente: C${clienteSeleccionado.nombre}\n` : ''}Total: C$C${calcularTotal().toFixed(2)}`;
    alert(mensaje);

    // Resetear
    setCarrito([]);
    setTipoVenta(null);
    setClienteSeleccionado(null);
  };

  const puedeAgregarProductos = tipoVenta === 'contado' || (tipoVenta === 'credito' && clienteSeleccionado);

  return (
    <div className="h-screen bg-gray-50 flex flex-col max-w-md mx-auto">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white p-4 shadow-lg">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-xl font-bold">Nueva Venta</h1>
          <ShoppingCart className="w-6 h-6" />
        </div>
        <div className="text-3xl font-bold">
          C${calcularTotal().toFixed(2)}
        </div>
      </div>

      {/* Tipo de Venta y Cliente */}
      <div className="p-4 space-y-3 bg-white border-b">
        <button
          onClick={() => setTipoVentaOpen(true)}
          className="w-full p-4 border-2 border-dashed border-gray-300 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition-colors"
        >
          {tipoVenta ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {tipoVenta === 'credito' ? <CreditCard className="w-5 h-5 text-blue-600" /> : <Wallet className="w-5 h-5 text-green-600" />}
                <span className="font-semibold capitalize">{tipoVenta}</span>
              </div>
              <span className="text-sm text-gray-500">Cambiar</span>
            </div>
          ) : (
            <span className="text-gray-500">Seleccionar tipo de venta</span>
          )}
        </button>

        {tipoVenta === 'credito' && (
          <button
            onClick={() => setClienteOpen(true)}
            className="w-full p-4 border-2 border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            {clienteSeleccionado ? (
              <div className="text-left">
                <div className="font-semibold">{clienteSeleccionado.nombre}</div>
                <div className="text-sm text-gray-500">{clienteSeleccionado.telefono}</div>
              </div>
            ) : (
              <span className="text-gray-500">Seleccionar cliente</span>
            )}
          </button>
        )}
      </div>

      {/* Carrito */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {carrito.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-400">
            <ShoppingCart className="w-16 h-16 mb-2" />
            <p>Carrito vacío</p>
            <p className="text-sm">Agrega productos para comenzar</p>
          </div>
        ) : (
          carrito.map(item => (
            <div key={item.id} className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
              <div className="flex justify-between items-start mb-2">
                <div className="flex-1">
                  <h3 className="font-semibold">{item.producto.nombre}</h3>
                  <div className="text-sm text-gray-600 mt-1">
                    <div>{item.libras} lbs × C${item.precioSugerido.toFixed(2)}</div>
                    {item.descuento > 0 && (
                      <div className="text-red-600">Descuento: {item.descuento}%</div>
                    )}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-bold text-lg">C${item.subtotal.toFixed(2)}</div>
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => handleEditarItem(item)}
                      className="p-1.5 text-blue-600 hover:bg-blue-50 rounded"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleEliminarItem(item.id)}
                      className="p-1.5 text-red-600 hover:bg-red-50 rounded"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer con botones */}
      <div className="p-4 bg-white border-t space-y-2">
        <button
          onClick={() => setProductosOpen(true)}
          disabled={!puedeAgregarProductos}
          className="w-full py-4 bg-blue-600 text-white rounded-lg font-semibold flex items-center justify-center gap-2 disabled:bg-gray-300 disabled:cursor-not-allowed hover:bg-blue-700 transition-colors"
        >
          <Plus className="w-5 h-5" />
          Agregar Producto
        </button>

        <button
          onClick={handleFinalizarVenta}
          disabled={carrito.length === 0}
          className="w-full py-4 bg-green-600 text-white rounded-lg font-semibold disabled:bg-gray-300 disabled:cursor-not-allowed hover:bg-green-700 transition-colors"
        >
          Finalizar Venta
        </button>
      </div>

      {/* Bottom Sheets */}
      <TipoVentaSheet
        open={tipoVentaOpen}
        onOpenChange={setTipoVentaOpen}
        onSelect={handleTipoVentaSelect}
      />

      <ClienteSheet
        open={clienteOpen}
        onOpenChange={setClienteOpen}
        onSelect={handleClienteSelect}
      />

      <ProductosSheet
        open={productosOpen}
        onOpenChange={setProductosOpen}
        onSelect={handleProductoSelect}
      />

      <DetalleProductoSheet
        open={detalleProductoOpen}
        onOpenChange={setDetalleProductoOpen}
        producto={productoSeleccionado}
        itemEditando={itemEditando}
        onAgregar={handleAgregarProducto}
      />
    </div>
  );
}
