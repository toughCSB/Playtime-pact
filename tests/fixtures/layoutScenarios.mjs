export const MAIN_LAYOUT_SIZES = [
  [420, 760],
  [375, 680],
  [320, 579],
  [249, 452],
  [240, 434],
]

export const ADMIN_LAYOUT_SIZES = [
  [400, 720],
  [377, 680],
  [320, 576],
  [251, 452],
  [240, 432],
]

export const LAYOUT_SCENARIOS = [
  { id: 'play-ready', window: 'main', marker: { selector: '[data-surface="play"] [data-phone-shell] .ppt-button--primary' } },
  { id: 'play-outside-hours', window: 'main', marker: { selector: '[data-surface="play"] [data-phone-shell] .ppt-lock-state' } },
  { id: 'play-active-overlay', window: 'main', presentation: 'overlay', marker: { selector: '.ppt-corner-timer' } },
  { id: 'play-approval', window: 'main', action: 'open-approval', marker: { selector: '[role="dialog"][aria-modal="true"] .ppt-pinpad__input[aria-label="부모님 4자리 PIN"]' } },
  { id: 'play-exhausted', window: 'main', marker: { selector: '[data-surface="play"] [data-phone-shell] .ppt-lock-state' } },
  { id: 'rules-long-copy', window: 'main', action: 'open-rules', marker: { selector: '[data-surface="rules"] [data-phone-shell] .ppt-rules-details' } },
  { id: 'settings-loaded', window: 'main', action: 'open-settings', marker: { selector: '[data-surface="settings"] [data-phone-shell] .ppt-scroll-stack' } },
  { id: 'settings-read-error', window: 'main', action: 'open-settings', marker: { selector: '[data-surface="settings"] [data-phone-shell] .ppt-inline-message--danger' } },
  { id: 'settings-validation-error', window: 'main', action: 'open-settings-invalid', marker: { selector: '[data-settings-error="validation"]' } },
  { id: 'settings-save-error', window: 'main', action: 'open-settings-save', marker: { selector: '[data-settings-error="save"]' } },
  { id: 'modal-long-korean-error', window: 'main', action: 'reject-approval', marker: { selector: '[role="dialog"][aria-modal="true"] .ppt-inline-message--danger', textIncludes: '문제가 계속되면 Playtime Pact를 다시 시작해주세요.' } },
  { id: 'admin-pin', window: 'admin', action: 'reject-admin-pin', marker: { selector: '.ppt-admin-auth .ppt-inline-message--danger' } },
  { id: 'admin-timer', window: 'admin', action: 'open-admin-timer', marker: { selector: '.ppt-admin-shell[data-admin-destination="timer"] [data-admin-panel="timer"]' } },
  { id: 'admin-safety', window: 'admin', action: 'open-admin-safety', marker: { selector: '.ppt-admin-shell[data-admin-destination="safety"] [data-admin-panel="safety"]' } },
  { id: 'admin-action-error', window: 'admin', action: 'admin-timer-error', marker: { selector: '.ppt-admin-shell[data-admin-destination="timer"] .ppt-inline-message--danger' } },
]
