import { useEffect } from "react";

import { useStore } from "../state/store";

/**
 * Transient status message.
 *
 * Auto-dismisses for informational messages but stays put for errors: a failed
 * network expansion is something the user needs to actually read, and having it
 * vanish mid-sentence is how people end up not knowing why nothing happened.
 */

const DISMISS_AFTER_MS = 4200;

export default function Toast() {
  const toast = useStore((s) => s.toast);
  const dismissToast = useStore((s) => s.dismissToast);

  useEffect(() => {
    if (!toast || toast.kind === "error") return;
    const timer = setTimeout(dismissToast, DISMISS_AFTER_MS);
    return () => clearTimeout(timer);
  }, [toast, dismissToast]);

  if (!toast) return null;

  return (
    <div
      className={`toast${toast.kind === "error" ? " toast-error" : ""}`}
      role="status"
      aria-live="polite"
    >
      <span>{toast.text}</span>
      <button type="button" onClick={dismissToast} aria-label="关闭提示">
        ×
      </button>
    </div>
  );
}
