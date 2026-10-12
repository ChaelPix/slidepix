export type ToastKind = "success" | "error" | "progress" | "dismiss";

export type ToastMessage = {
  id: string;
  kind: ToastKind;
  message?: string;
  progress?: number;
};

export type ManimProgressDetail = {
  elementId: string;
  status: ToastKind;
  percent: number;
};

const MANIM_PROGRESS_EVENT = "slidepix-manim-progress";

export function publishManimProgress(detail: ManimProgressDetail): void {
  window.dispatchEvent(new CustomEvent<ManimProgressDetail>(MANIM_PROGRESS_EVENT, { detail }));
}

const MANIM_PROGRESS_CLEAR = "slidepix-manim-progress-clear";

export function clearManimProgress(): void {
  window.dispatchEvent(new CustomEvent(MANIM_PROGRESS_CLEAR));
}

export function onManimProgressClear(listener: () => void): () => void {
  window.addEventListener(MANIM_PROGRESS_CLEAR, listener);
  return () => window.removeEventListener(MANIM_PROGRESS_CLEAR, listener);
}

export function onManimProgress(listener: (detail: ManimProgressDetail) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<ManimProgressDetail>).detail);
  window.addEventListener(MANIM_PROGRESS_EVENT, handle);
  return () => window.removeEventListener(MANIM_PROGRESS_EVENT, handle);
}

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
