import { useState } from 'react';
import { Drawer } from 'vaul';
import { Search, Package } from 'lucide-react';
import { ImageWithFallback } from './figma/ImageWithFallback';
import type { Producto } from '../App';

// Mock data de productos
const PRODUCTOS_MOCK: Producto[] = [
  { id: '1', nombre: 'Posta de Cerdo', precioBase: 4.50, existencia: 38.0, imagen: 'https://images.unsplash.com/photo-1602470520998-f4a52199a3d6?w=300&q=80' },
  { id: '2', nombre: 'Pierna entera', precioBase: 3.75, existencia: 28.5, imagen: 'https://images.unsplash.com/photo-1598103442097-8b74394b95c6?w=300&q=80' },
  { id: '3', nombre: 'Pechuga entera', precioBase: 4.25, existencia: 32.0, imagen: 'https://images.unsplash.com/photo-1604503468506-a8da13d82791?w=300&q=80' },
  { id: '4', nombre: 'Menudo', precioBase: 2.50, existencia: 15.0, imagen: 'https://images.unsplash.com/photo-1587593810167-a84920ea0781?w=300&q=80' },
  { id: '5', nombre: 'Huevos', precioBase: 3.00, existencia: 120.0, imagen: 'https://images.unsplash.com/photo-1582722872445-44dc5f7e3c8f?w=300&q=80' },
  { id: '6', nombre: 'Chincaca', precioBase: 3.25, existencia: 42.0, imagen: 'https://images.unsplash.com/photo-1607623488235-f30c7b28b5b8?w=300&q=80' },
  { id: '7', nombre: 'Costilla de Cerdo', precioBase: 5.25, existencia: 21.5, imagen: 'https://images.unsplash.com/photo-1544025162-d76694265947?w=300&q=80' },
  { id: '8', nombre: 'Bistec de Res', precioBase: 7.00, existencia: 24.5, imagen: 'https://images.unsplash.com/photo-1588168333986-5078d3ae3976?w=300&q=80' },
  { id: '9', nombre: 'Carne Molida', precioBase: 5.50, existencia: 55.0, imagen: 'https://images.unsplash.com/photo-1603048588665-791ca8aea617?w=300&q=80' },
  { id: '10', nombre: 'Alas de Pollo', precioBase: 3.00, existencia: 19.0, imagen: 'https://images.unsplash.com/photo-1527477396000-e27163b481c2?w=300&q=80' },
];

interface ProductosSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (producto: Producto) => void;
}

export function ProductosSheet({ open, onOpenChange, onSelect }: ProductosSheetProps) {
  const [busqueda, setBusqueda] = useState('');

  const productosFiltrados = PRODUCTOS_MOCK.filter(producto =>
    producto.nombre.toLowerCase().includes(busqueda.toLowerCase())
  );

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/40" />
        <Drawer.Content className="bg-white flex flex-col rounded-t-[10px] h-[80%] mt-24 fixed bottom-0 left-0 right-0 max-w-md mx-auto">
          <div className="p-4 bg-white rounded-t-[10px] flex-1 flex flex-col">
            <div className="mx-auto w-12 h-1.5 flex-shrink-0 rounded-full bg-gray-300 mb-4" />
            <div className="max-w-md mx-auto w-full flex-1 flex flex-col">
              <Drawer.Title className="font-bold text-2xl mb-2">
                Seleccionar Producto
              </Drawer.Title>
              <Drawer.Description className="text-gray-600 mb-4">
                Selecciona los productos para agregar al carrito
              </Drawer.Description>

              <div className="relative mb-4">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                <input
                  type="text"
                  placeholder="Buscar producto..."
                  value={busqueda}
                  onChange={(e) => setBusqueda(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* VISTA LISTA - Código comentado para comparación */}
              {/* <div className="flex-1 overflow-y-auto space-y-2">
                {productosFiltrados.map(producto => (
                  <button
                    key={producto.id}
                    onClick={() => onSelect(producto)}
                    className="w-full p-4 bg-gray-50 hover:bg-blue-50 rounded-lg border border-gray-200 hover:border-blue-300 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-green-100 rounded-full">
                          <Package className="w-5 h-5 text-green-600" />
                        </div>
                        <div className="text-left">
                          <div className="font-semibold">{producto.nombre}</div>
                          <div className="text-sm text-gray-600">
                            Precio base: C${producto.precioBase.toFixed(2)}/lb
                          </div>
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
                {productosFiltrados.length === 0 && (
                  <div className="text-center py-8 text-gray-500">
                    No se encontraron productos
                  </div>
                )}
              </div> */}

              {/* VISTA GRID CON IMÁGENES - Estilo POS Profesional */}
              <div className="flex-1 overflow-y-auto overscroll-contain">
                {productosFiltrados.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    No se encontraron productos
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 pb-4">
                    {productosFiltrados.map(producto => (
                      <button
                        key={producto.id}
                        onClick={() => onSelect(producto)}
                        className="bg-white rounded-xl border-2 border-gray-200 hover:border-blue-500 hover:shadow-lg transition-all overflow-hidden"
                      >
                        <div className="aspect-[4/3] bg-gray-100 relative overflow-hidden">
                          <ImageWithFallback
                            src={producto.imagen}
                            alt={producto.nombre}
                            className="w-full h-full object-cover"
                          />
                          {producto.existencia < 20 && (
                            <div className="absolute top-2 right-2 bg-red-500 text-white text-xs px-2 py-1 rounded-full font-semibold">
                              Bajo stock
                            </div>
                          )}
                        </div>
                        <div className="p-3">
                          <h3 className="font-semibold text-sm mb-2 line-clamp-2 min-h-[2.5rem]">
                            {producto.nombre}
                          </h3>
                          <div className="space-y-1">
                            <div className="flex items-center justify-between">
                              <span className="text-xs text-gray-500">Precio</span>
                              <span className="font-bold text-green-600">
                                C${producto.precioBase.toFixed(2)}/lb
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-xs text-gray-500">Stock</span>
                              <span className={`font-semibold text-sm C${producto.existencia < 20 ? 'text-red-600' : 'text-gray-700'}`}>
                                {producto.existencia.toFixed(1)} lbs
                              </span>
                            </div>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
