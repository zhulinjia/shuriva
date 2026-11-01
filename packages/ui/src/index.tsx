import { Button as BaseButton } from "@base-ui/react/button";
import { Dialog } from "@base-ui/react/dialog";
import { type ComponentProps, type ReactNode, useRef } from "react";

export function Button(props: ComponentProps<typeof BaseButton>) {
  return <BaseButton {...props} />;
}

export function ConfirmDialog({
  open,
  title,
  description,
  children,
  confirmLabel,
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  children?: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root
      open={open}
      modal
      disablePointerDismissal
      onOpenChange={(next, details) => {
        if (!next) {
          if (busy) details.cancel();
          else onCancel();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Popup className="dialog-popup" initialFocus={cancel} aria-busy={busy}>
          <div className="dialog-head">
            <Dialog.Title>{title}</Dialog.Title>
          </div>
          <div className="dialog-body">
            <Dialog.Description>{description}</Dialog.Description>
            {children}
            {busy && <p role="status">正在处理，请稍候…</p>}
          </div>
          <div className="dialog-actions">
            <Dialog.Close ref={cancel} type="button" className="outline-button" disabled={busy}>
              取消
            </Dialog.Close>
            <Button
              type="button"
              className="dialog-primary"
              disabled={busy || confirmDisabled}
              onClick={onConfirm}
            >
              {busy ? "处理中…" : confirmLabel}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface InfoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}

export function InfoDialog({ open, onOpenChange, title, children }: InfoDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Popup className="dialog-popup">
          <div className="dialog-head">
            <div>
              <span className="dialog-eyebrow">DATA WORKSPACE</span>
              <Dialog.Title>{title}</Dialog.Title>
            </div>
            <Dialog.Close className="icon-button" aria-label="关闭">
              ×
            </Dialog.Close>
          </div>
          <div className="dialog-body">{children}</div>
          <div className="dialog-actions">
            <Dialog.Close className="outline-button">关闭</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
