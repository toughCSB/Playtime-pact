import { useEffect, useRef } from 'react'

interface PinPadProps {
  id: string
  label: string
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
  onCancel?: () => void
  submitLabel?: string
  cancelLabel?: string
  disabled?: boolean
  error?: string
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

export function appendPinDigit(value: string, digit: string): string {
  const current = value.replace(/\D/g, '').slice(0, 4)
  if (!/^\d$/.test(digit)) return current
  return `${current}${digit}`.slice(0, 4)
}

export function removePinDigit(value: string): string {
  return value.replace(/\D/g, '').slice(0, 4).slice(0, -1)
}

export default function PinPad({
  id,
  label,
  value,
  onChange,
  onSubmit,
  onCancel,
  submitLabel = '확인',
  cancelLabel = '취소',
  disabled = false,
  error,
}: PinPadProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    window.requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  useEffect(() => {
    if (disabled) return
    window.requestAnimationFrame(() => inputRef.current?.focus())
  }, [disabled, error])

  const focusInput = () => {
    window.requestAnimationFrame(() => inputRef.current?.focus())
  }

  const appendDigit = (digit: string) => {
    if (disabled) return
    onChange(appendPinDigit(value, digit))
    focusInput()
  }

  const removeDigit = () => {
    if (disabled) return
    onChange(removePinDigit(value))
    focusInput()
  }

  return (
    <div className="ppt-pinpad">
      <div className="ppt-pinpad__display">
        <input
          ref={inputRef}
          id={id}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          value={value}
          disabled={disabled}
          aria-label={label}
          aria-invalid={Boolean(error)}
          aria-describedby={`${id}-status`}
          className="ppt-pinpad__input"
          onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 4))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              onSubmit()
            }
          }}
        />
        <div className="ppt-pinpad__dots" aria-hidden="true">
          {[0, 1, 2, 3].map((index) => (
            <span key={index} className={`ppt-pinpad__dot${index < value.length ? ' is-filled' : ''}`} />
          ))}
        </div>
      </div>

      <div id={`${id}-status`} className="ppt-status-slot" aria-live="polite">
        {error ? <p className="ppt-inline-message ppt-inline-message--danger">{error}</p> : null}
      </div>

      <div className="ppt-pinpad__keys">
        {KEYS.map((digit) => (
          <button key={digit} type="button" className="ppt-pinpad__key" onClick={() => appendDigit(digit)} disabled={disabled}>
            {digit}
          </button>
        ))}
        <button type="button" className="ppt-pinpad__key ppt-pinpad__key--muted" onClick={removeDigit} disabled={disabled} aria-label="한 자리 지우기">
          ⌫
        </button>
        <button type="button" className="ppt-pinpad__key" onClick={() => appendDigit('0')} disabled={disabled}>
          0
        </button>
        <button
          type="button"
          className="ppt-pinpad__key ppt-pinpad__key--primary"
          onClick={onSubmit}
          disabled={disabled || value.length !== 4}
        >
          {submitLabel}
        </button>
      </div>

      {onCancel ? (
        <button type="button" className="ppt-text-button" onClick={onCancel}>
          {cancelLabel}
        </button>
      ) : null}
    </div>
  )
}
