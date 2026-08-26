export interface ComposerFocusTarget {
  readonly isConnected: boolean
  readonly value: string
  focus: (options?: FocusOptions) => void
  setSelectionRange: (start: number, end: number) => void
}

export function focusComposerAtEnd(target: ComposerFocusTarget | null): boolean {
  if (!target?.isConnected) return false
  target.focus({ preventScroll: true })
  const end = target.value.length
  try {
    target.setSelectionRange(end, end)
  } catch {
    // Some accessibility/input implementations can focus without exposing a selection range.
  }
  return true
}
