export type ToastKind = "ok" | "err" | "info";
type Listener = (msg: string, kind: ToastKind) => void;

let _listener: Listener | null = null;

export function registerToastListener(fn: Listener) { _listener = fn; }
export function unregisterToastListener()           { _listener = null; }

export function toast(msg: string, kind: ToastKind = "ok") {
  _listener?.(msg, kind);
}
