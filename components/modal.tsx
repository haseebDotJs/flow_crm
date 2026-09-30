"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { X } from "lucide-react";

const CloseContext = createContext<(() => void) | undefined>(undefined);

/** Close handler of the enclosing Modal, if any. */
export function useModalClose() {
  return useContext(CloseContext);
}

export function Modal({
  triggerLabel,
  triggerClassName = "btn-primary",
  triggerIcon,
  title,
  children,
}: {
  triggerLabel: string;
  triggerClassName?: string;
  triggerIcon?: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button type="button" className={triggerClassName} onClick={() => setOpen(true)}>
        {triggerIcon} {triggerLabel}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <div role="dialog" aria-modal="true" aria-label={title} className="card w-full max-w-md p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold">{title}</h2>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="text-slate-400 hover:text-slate-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <CloseContext.Provider value={() => setOpen(false)}>{children}</CloseContext.Provider>
          </div>
        </div>
      )}
    </>
  );
}
