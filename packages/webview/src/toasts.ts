export type ToastKind = "success" | "error" | "progress" | "dismiss";

export type ToastMessage = {
  id: string;
  kind: ToastKind;
  message?: string;
};

const TOAST_EVENT = "slidepix-toast";

export function notifyToast(toast: ToastMessage): void {
  window.dispatchEvent(new CustomEvent<ToastMessage>(TOAST_EVENT, { detail: toast }));
}

export function onToast(listener: (toast: ToastMessage) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<ToastMessage>).detail);
  window.addEventListener(TOAST_EVENT, handle);
  return () => window.removeEventListener(TOAST_EVENT, handle);
}

export function updateToasts(current: ToastMessage[], toast: ToastMessage): ToastMessage[] {
  if (toast.kind === "dismiss") return current.filter((item) => item.id !== toast.id);
  return [...current.filter((item) => item.id !== toast.id), toast];
}
