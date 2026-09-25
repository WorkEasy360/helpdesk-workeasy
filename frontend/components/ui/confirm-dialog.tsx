'use client';

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from './button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';

export interface ConfirmOptions {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive actions get a red confirm button and a warning icon. Defaults to true. */
  destructive?: boolean;
  /**
   * Runs while the dialog stays open with a pending button. If it throws, the dialog
   * stays open so the user can retry or cancel — callers surface the error themselves
   * (mutations here already toast in `onError`).
   */
  onConfirm?: () => unknown | Promise<unknown>;
}

interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Controlled confirmation dialog. Prefer `useConfirm()` for one-off confirmations. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = true,
  onConfirm,
}: ConfirmDialogProps) {
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    if (!open) setPending(false);
  }, [open]);

  const confirm = async () => {
    if (!onConfirm) {
      onOpenChange(false);
      return;
    }
    setPending(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // Keep the dialog open; the action reports its own failure.
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Do not let Escape / overlay clicks dismiss an action that is mid-flight.
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent role="alertdialog" className="max-w-md">
        <DialogHeader className="flex flex-row items-start gap-3 space-y-0 pr-6">
          {destructive ? (
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle className="h-4 w-4" aria-hidden />
            </span>
          ) : null}
          <div className="space-y-1">
            <DialogTitle>{title}</DialogTitle>
            {description ? (
              <DialogDescription>{description}</DialogDescription>
            ) : (
              <DialogDescription className="sr-only">Confirm this action.</DialogDescription>
            )}
          </div>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={() => void confirm()}
            loading={pending}
            autoFocus
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = React.createContext<ConfirmFn | null>(null);

interface PendingConfirm extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
}

/** Mount once near the root; `useConfirm()` then works anywhere below it. */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [current, setCurrent] = React.useState<PendingConfirm | null>(null);
  const [open, setOpen] = React.useState(false);
  const confirmedRef = React.useRef(false);

  const confirm = React.useCallback<ConfirmFn>(
    (options) =>
      new Promise<boolean>((resolve) => {
        confirmedRef.current = false;
        setCurrent({ ...options, resolve });
        setOpen(true);
      }),
    [],
  );

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next && current) {
      current.resolve(confirmedRef.current);
    }
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {current ? (
        <ConfirmDialog
          {...current}
          open={open}
          onOpenChange={handleOpenChange}
          onConfirm={async () => {
            await current.onConfirm?.();
            confirmedRef.current = true;
          }}
        />
      ) : null}
    </ConfirmContext.Provider>
  );
}

/**
 * Promise-based replacement for `window.confirm`:
 *
 *   const confirm = useConfirm();
 *   confirm({ title: 'Delete this?', confirmLabel: 'Delete', onConfirm: () => remove.mutateAsync(id) });
 *
 * Resolves `true` once confirmed (after `onConfirm` settles), `false` when dismissed.
 */
export function useConfirm(): ConfirmFn {
  const confirm = React.useContext(ConfirmContext);
  if (!confirm) {
    throw new Error('useConfirm must be used inside <ConfirmProvider>');
  }
  return confirm;
}
