// 基础组件:按钮、输入、对话框、进度、吐司、在线点、骨架、空态
import { useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import { CircleNotch, Warning, X } from '@phosphor-icons/react'
import { useHub } from '../store/hub'

// ---------- 按钮 ----------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger-ghost'

const BUTTON_STYLE: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-on-primary hover:opacity-90',
  secondary: 'bg-surface-2 text-ink hover:bg-line',
  ghost: 'text-ink hover:bg-surface-2',
  'danger-ghost': 'text-danger hover:bg-danger-soft',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  loading?: boolean
}

export function Button({ variant = 'primary', loading = false, className = '', children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-[10px] px-3.5 text-[13px] font-medium transition-[opacity,background-color,transform] duration-150 active:scale-[0.98] disabled:opacity-50 ${BUTTON_STYLE[variant]} ${className}`}
    >
      {loading && (
        <span className="inline-flex animate-spin">
          <CircleNotch size={15} weight="bold" />
        </span>
      )}
      {children}
    </button>
  )
}

export function IconButton({
  label,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink active:scale-[0.98] disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  )
}

// ---------- 输入 ----------

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  hint?: string
  error?: string
}

export function Field({ label, hint, error, id, className = '', ...rest }: FieldProps) {
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-medium">
        {label}
      </label>
      <input
        id={id}
        {...rest}
        className={`h-10 w-full rounded-[10px] border bg-bg px-3 text-[14px] outline-none transition-colors placeholder:text-muted/70 focus:border-primary ${
          error ? 'border-danger' : 'border-line'
        }`}
      />
      {error ? (
        <p className="mt-1.5 text-[12px] text-danger">{error}</p>
      ) : hint ? (
        <p className="mt-1.5 text-[12px] text-muted">{hint}</p>
      ) : null}
    </div>
  )
}

// ---------- 对话框(原生 <dialog>) ----------

export function Dialog({
  open,
  onClose,
  title,
  children,
  width = 'max-w-sm',
  dim = 'normal',
}: {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  width?: string
  /** 灯箱等强层级场景用 deep,普通确认框用 normal */
  dim?: 'normal' | 'deep'
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(
    function syncDialog() {
      const el = ref.current
      if (!el) return
      if (open && !el.open) el.showModal()
      if (!open && el.open) el.close()
    },
    [open],
  )

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => {
        // 点到 backdrop(元素自身)时关闭
        if (e.target === ref.current) onClose()
      }}
      className={`anim-pop m-auto w-[calc(100vw-32px)] ${width} rounded-[14px] border border-line bg-bg p-5 text-ink shadow-xl open:backdrop:anim-fade ${
        dim === 'deep' ? 'backdrop:bg-black/70' : 'backdrop:bg-black/45'
      }`}
    >
      {title && <h2 className="mb-3 text-[16px] font-semibold">{title}</h2>}
      {children}
    </dialog>
  )
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = '删除',
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  body?: string
  confirmLabel?: string
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      {body && <p className="mb-4 text-[13px] text-muted">{body}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button
          className="bg-danger text-white hover:opacity-90"
          onClick={() => {
            onConfirm()
            onClose()
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  )
}

// ---------- 进度条(scaleX,GPU) ----------

export function Progress({ value, tone = 'primary' }: { value: number; tone?: 'primary' | 'warning' }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
      {/* 不加 transition:高速传输时补间会让填充滞后于数字,数字与条必须一致 */}
      <div
        className={`h-full w-full origin-left rounded-full ${
          tone === 'primary' ? 'bg-primary' : 'bg-warning'
        }`}
        style={{ transform: `scaleX(${Math.min(1, Math.max(0.015, value))})` }}
      />
    </div>
  )
}

// ---------- 在线状态点(语义状态,伴随文字使用) ----------

export function PresenceDot({ online, connecting = false }: { online: boolean; connecting?: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-2 w-2 shrink-0 rounded-full transition-colors duration-150 ${
        online ? 'bg-primary' : connecting ? 'bg-primary anim-breathe' : 'border border-muted/50 bg-transparent'
      }`}
    />
  )
}

// ---------- 骨架与空态 ----------

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-[10px] bg-surface-2 ${className}`} />
}

export function EmptyState({
  icon,
  title,
  hint,
}: {
  icon: ReactNode
  title: string
  hint?: string
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-[14px] bg-surface text-muted">
        {icon}
      </div>
      <p className="text-[14px] font-medium">{title}</p>
      {hint && <p className="max-w-[36ch] text-[13px] text-muted">{hint}</p>}
    </div>
  )
}

// ---------- 吐司 ----------

export function Toasts() {
  const toasts = useHub((s) => s.toasts)
  const dismiss = useHub((s) => s.dismissToast)
  if (toasts.length === 0) return null
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`anim-rise pointer-events-auto flex max-w-[92vw] items-center gap-2 rounded-[10px] border px-3.5 py-2.5 text-[13px] shadow-lg ${
            t.kind === 'error' ? 'border-danger/30 bg-danger-soft text-ink' : 'border-line bg-bg text-ink'
          }`}
        >
          {t.kind === 'error' && <Warning size={15} className="shrink-0 text-danger" weight="fill" />}
          <span className="min-w-0 break-all">{t.text}</span>
          <button
            aria-label="关闭提示"
            onClick={() => dismiss(t.id)}
            className="ml-1 shrink-0 rounded p-0.5 text-muted hover:text-ink"
          >
            <X size={13} weight="bold" />
          </button>
        </div>
      ))}
    </div>
  )
}
