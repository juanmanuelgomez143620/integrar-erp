import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

/** Confirmación que describe el efecto de la acción y, si corresponde, pide motivo. */
export function ActionDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  tone = 'default',
  reason,
  reasonLabel = 'Motivo',
  reasonRequired = false,
  busy,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  confirmLabel: string
  tone?: 'default' | 'destructive' | 'outline'
  reason?: boolean
  reasonLabel?: string
  reasonRequired?: boolean
  busy?: boolean
  onConfirm: (reason: string) => void
}) {
  const [text, setText] = useState('')
  const invalid = reason && reasonRequired && text.trim().length < 3
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setText('')
        onOpenChange(o)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {reason && (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-700">
              {reasonLabel}
              {reasonRequired && <span className="text-red-600"> *</span>}
            </label>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              autoFocus
              placeholder={reasonRequired ? 'Queda registrado en el historial del documento.' : 'Opcional'}
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Volver
          </Button>
          <Button
            variant={tone === 'destructive' ? 'destructive' : 'default'}
            disabled={busy || invalid}
            onClick={() => onConfirm(text.trim())}
          >
            {busy ? 'Procesando…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
