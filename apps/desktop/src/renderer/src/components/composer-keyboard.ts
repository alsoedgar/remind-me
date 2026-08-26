export interface ComposerKeyIntent {
  key: string
  shiftKey: boolean
  isComposing: boolean
}

export function shouldSubmitComposerKey(intent: ComposerKeyIntent): boolean {
  return intent.key === 'Enter' && !intent.shiftKey && !intent.isComposing
}
