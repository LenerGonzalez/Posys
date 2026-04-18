import { useState } from 'react';
import { Drawer } from 'vaul';
import { Search, User } from 'lucide-react';
import type { Cliente } from '../App';

// Mock data de clientes
const CLIENTES_MOCK: Cliente[] = [
  { id: '1', nombre: 'Juan Pérez', telefono: '809-555-0101' },
  { id: '2', nombre: 'María García', telefono: '809-555-0102' },
  { id: '3', nombre: 'Carlos Rodríguez', telefono: '809-555-0103' },
  { id: '4', nombre: 'Ana Martínez', telefono: '809-555-0104' },
  { id: '5', nombre: 'Luis Hernández', telefono: '809-555-0105' },
  { id: '6', nombre: 'Carmen López', telefono: '809-555-0106' },
  { id: '7', nombre: 'Pedro Sánchez', telefono: '809-555-0107' },
  { id: '8', nombre: 'Rosa Jiménez', telefono: '809-555-0108' },
];

interface ClienteSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (cliente: Cliente) => void;
}

export function ClienteSheet({ open, onOpenChange, onSelect }: ClienteSheetProps) {
  const [busqueda, setBusqueda] = useState('');

  const clientesFiltrados = CLIENTES_MOCK.filter(cliente =>
    cliente.nombre.toLowerCase().includes(busqueda.toLowerCase()) ||
    cliente.telefono.includes(busqueda)
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
                Seleccionar Cliente
              </Drawer.Title>
              <Drawer.Description className="text-gray-600 mb-4">
                Busca y selecciona el cliente para la venta a crédito
              </Drawer.Description>

              <div className="relative mb-4">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                <input
                  type="text"
                  placeholder="Buscar cliente..."
                  value={busqueda}
                  onChange={(e) => setBusqueda(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="flex-1 overflow-y-auto space-y-2">
                {clientesFiltrados.map(cliente => (
                  <button
                    key={cliente.id}
                    onClick={() => onSelect(cliente)}
                    className="w-full p-4 bg-gray-50 hover:bg-blue-50 rounded-lg border border-gray-200 hover:border-blue-300 transition-colors text-left"
                  >
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-blue-100 rounded-full">
                        <User className="w-5 h-5 text-blue-600" />
                      </div>
                      <div>
                        <div className="font-semibold">{cliente.nombre}</div>
                        <div className="text-sm text-gray-600">{cliente.telefono}</div>
                      </div>
                    </div>
                  </button>
                ))}
                {clientesFiltrados.length === 0 && (
                  <div className="text-center py-8 text-gray-500">
                    No se encontraron clientes
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
