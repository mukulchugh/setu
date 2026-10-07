// Base UI owns notification timing, pause-on-focus/hover and one close path.

import { Toast as ToastPrimitive } from '@base-ui/react/toast';
import { useEffect, useRef } from 'preact/hooks';
import { cn } from './utils';

export type Tone = 'emerald' | 'amber' | 'red' | 'zinc';
export interface ToastItem {
  id: number;
  msg: string;
  tone: Tone;
}
const TOAST_BG: Record<Tone, string> = {
  amber: 'bg-signal-amber/95 border-signal-amber',
  emerald: 'bg-signal-green/95 border-signal-green',
  red: 'bg-signal-red/95 border-signal-red',
  zinc: 'bg-zinc-900/95 border-zinc-800',
};

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager();
  return (
    <>
      {toasts.map((t) => (
        <ToastPrimitive.Root
          aria-label={t.type === 'red' ? 'Action failed' : 'Notification'}
          className={cn(
            'pointer-events-auto w-full max-w-md select-text rounded-none border px-4 py-2.5 text-left text-white text-xs shadow-lg backdrop-blur-md transition-all duration-200 ease-out data-[limited]:hidden data-[starting-style]:translate-y-2 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0',
            TOAST_BG[t.type as Tone] ?? TOAST_BG.zinc
          )}
          key={t.id}
          swipeDirection={['down', 'up', 'left', 'right']}
          toast={t}
        >
          <ToastPrimitive.Content className="flex items-center gap-3">
            <ToastPrimitive.Description className="flex-1 break-words text-white text-xs" />
            <ToastPrimitive.Close
              aria-label="Close notification"
              className="flex h-11 w-11 shrink-0 items-center justify-center border border-white/40"
            >
              ×
            </ToastPrimitive.Close>
          </ToastPrimitive.Content>
        </ToastPrimitive.Root>
      ))}
    </>
  );
}

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  const managerRef =
    useRef<ReturnType<typeof ToastPrimitive.createToastManager>>();
  if (!managerRef.current) {
    managerRef.current = ToastPrimitive.createToastManager();
  }
  const manager = managerRef.current;
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const mirroredIds = useRef(new Set<number>());
  useEffect(() => {
    const ids = new Set(toasts.map((t) => t.id));
    for (const t of toasts) {
      if (mirroredIds.current.has(t.id)) {
        continue;
      }
      mirroredIds.current.add(t.id);
      manager.add({
        description: t.msg,
        id: String(t.id),
        onClose: () => dismiss.current(t.id),
        timeout: t.tone === 'red' ? 0 : 5000,
        type: t.tone,
      });
    }
    for (const id of mirroredIds.current) {
      if (ids.has(id)) {
        continue;
      }
      mirroredIds.current.delete(id);
      manager.close(String(id));
    }
  }, [toasts]);
  return (
    <ToastPrimitive.Provider limit={3} toastManager={manager}>
      <ToastPrimitive.Portal>
        <ToastPrimitive.Viewport className="pointer-events-none fixed bottom-5 left-1/2 z-[60] flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 flex-col-reverse items-center gap-2">
          <ToastList />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}
