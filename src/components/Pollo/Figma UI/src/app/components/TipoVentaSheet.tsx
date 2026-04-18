import { Drawer } from 'vaul';
import { CreditCard, Wallet } from 'lucide-react';

interface TipoVentaSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (tipo: 'credito' | 'contado') => void;
}

export function TipoVentaSheet({ open, onOpenChange, onSelect }: TipoVentaSheetProps) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/40" />
        <Drawer.Content className="bg-white flex flex-col rounded-t-[10px] h-[50%] mt-24 fixed bottom-0 left-0 right-0 max-w-md mx-auto">
          <div className="p-4 bg-white rounded-t-[10px] flex-1">
            <div className="mx-auto w-12 h-1.5 flex-shrink-0 rounded-full bg-gray-300 mb-8" />
            <div className="max-w-md mx-auto">
              <Drawer.Title className="font-bold text-2xl mb-2">
                Tipo de Venta
              </Drawer.Title>
              <Drawer.Description className="text-gray-600 mb-6">
                Selecciona el tipo de venta que deseas realizar
              </Drawer.Description>
              <div className="space-y-3">
                <button
                  onClick={() => onSelect('credito')}
                  className="w-full p-6 bg-blue-50 border-2 border-blue-300 rounded-xl hover:bg-blue-100 transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <div className="p-3 bg-blue-600 rounded-lg">
                      <CreditCard className="w-8 h-8 text-white" />
                    </div>
                    <div className="text-left">
                      <div className="font-bold text-xl">Crédito</div>
                      <div className="text-sm text-gray-600">Venta a cliente registrado</div>
                    </div>
                  </div>
                </button>

                <button
                  onClick={() => onSelect('contado')}
                  className="w-full p-6 bg-green-50 border-2 border-green-300 rounded-xl hover:bg-green-100 transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <div className="p-3 bg-green-600 rounded-lg">
                      <Wallet className="w-8 h-8 text-white" />
                    </div>
                    <div className="text-left">
                      <div className="font-bold text-xl">Contado</div>
                      <div className="text-sm text-gray-600">Pago inmediato</div>
                    </div>
                  </div>
                </button>
              </div>
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
