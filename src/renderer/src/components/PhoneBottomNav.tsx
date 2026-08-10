export interface PhoneNavItem {
  id: string
  label: string
  icon: string
}

interface PhoneBottomNavProps {
  current: string
  items: PhoneNavItem[]
  onSelect: (id: string) => void
}

export default function PhoneBottomNav({ current, items, onSelect }: PhoneBottomNavProps) {
  return (
    <nav className="ppt-bottom-nav" aria-label="주요 화면">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="ppt-bottom-nav__item"
          aria-current={current === item.id ? 'page' : undefined}
          onClick={() => onSelect(item.id)}
        >
          <span className="ppt-bottom-nav__icon" aria-hidden="true">{item.icon}</span>
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  )
}
