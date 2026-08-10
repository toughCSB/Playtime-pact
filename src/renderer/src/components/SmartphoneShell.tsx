import { useEffect, useRef, useState, type MutableRefObject, type ReactNode, type RefObject } from 'react'

interface SmartphoneShellProps {
  children: ReactNode
  nav?: ReactNode
  surface: string
  title: string
}
const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function useModalFocusBoundary(
  open: boolean,
  dialogRef: RefObject<HTMLElement | null>,
  backgroundRef: RefObject<HTMLElement | null>,
  triggerRef: MutableRefObject<HTMLElement | null>,
  onClose: () => void,
) {
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])
  useEffect(() => {
    if (!open) return
    const background = backgroundRef.current
    const dialog = dialogRef.current
    const backgrounds = background
      ? Array.from(background.children).filter((element) => !element.contains(dialog))
      : []
    const previousStates = backgrounds.map((element) => ({
      element,
      hadInert: element.hasAttribute('inert'),
      ariaHidden: element.getAttribute('aria-hidden'),
    }))
    for (const element of backgrounds) {
      element.setAttribute('inert', '')
      element.setAttribute('aria-hidden', 'true')
    }

    const focusInitial = () => {
      const dialog = dialogRef.current
      const initial = dialog?.querySelector<HTMLElement>('[data-modal-initial-focus], input:not([disabled]), button:not([disabled])')
      initial?.focus()
    }
    window.requestAnimationFrame(focusInitial)

    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current
      if (!dialog) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement)
      const nextIndex = event.shiftKey
        ? currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1
        : currentIndex === focusable.length - 1 ? 0 : currentIndex + 1
      event.preventDefault()
      focusable[nextIndex].focus()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      for (const { element, hadInert, ariaHidden } of previousStates) {
        if (hadInert) element.setAttribute('inert', '')
        else element.removeAttribute('inert')
        if (ariaHidden === null) element.removeAttribute('aria-hidden')
        else element.setAttribute('aria-hidden', ariaHidden)
      }
    }
  }, [open, dialogRef, backgroundRef])

  useEffect(() => {
    if (open) return
    const trigger = triggerRef.current
    if (!trigger) return
    window.requestAnimationFrame(() => {
      trigger.focus()
      triggerRef.current = null
    })
  }, [open, triggerRef])
}

function getGeometryClass(surface: string) {
  const isAdmin = surface.startsWith('admin-')
  const preferredWidth = isAdmin ? 400 : 420
  const preferredHeight = isAdmin ? 720 : 760
  return window.innerWidth >= preferredWidth && window.innerHeight >= preferredHeight ? 'preferred' : 'scaled'
}

export default function SmartphoneShell({ children, nav, surface, title }: SmartphoneShellProps) {
  const [geometryClass, setGeometryClass] = useState(() => getGeometryClass(surface))

  useEffect(() => {
    const updateGeometryClass = () => setGeometryClass(getGeometryClass(surface))
    updateGeometryClass()
    window.addEventListener('resize', updateGeometryClass)
    return () => window.removeEventListener('resize', updateGeometryClass)
  }, [surface])

  return (
    <div className="ppt-phone-stage no-drag" data-surface={surface} data-geometry-class={geometryClass}>
      <div className="ppt-phone-shell" data-phone-shell>
        <div className="ppt-phone-rim app-drag" aria-hidden="true">
          <span className="ppt-phone-sensor" />
        </div>
        <section className="ppt-phone-screen no-drag" data-phone-screen aria-label={title}>
          <div className="ppt-phone-content" data-phone-content>
            {children}
          </div>
          {nav ? <div className="ppt-phone-nav no-drag" data-phone-nav>{nav}</div> : null}
        </section>
        <div className="ppt-phone-home-indicator no-drag" aria-hidden="true" />
      </div>
    </div>
  )
}
