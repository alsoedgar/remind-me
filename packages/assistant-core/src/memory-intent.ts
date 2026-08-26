export type MemoryIntent =
  | { kind: 'set-name'; name: string }
  | { kind: 'remember'; memory: string }
  | { kind: 'recall' }
  | { kind: 'forget'; memory: string }
  | { kind: 'forget-all' }

function cleanValue(value: string): string {
  return value
    .trim()
    .replace(/[.!?]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

function containsAnotherAppAction(value: string): boolean {
  return /(?:[,;]|\b(?:and|also|then)\b)\s*(?:please\s+)?(?:add|book|cancel|change|complete|copy|create|delete|duplicate|move|remind|remove|rename|repeat|reschedule|schedule|set|shift|show|update)\b/iu.test(
    value
  )
}

/** Parses only explicit personal-memory turns so reminder requests are never swallowed. */
export function parseMemoryIntent(text: string): MemoryIntent | null {
  const source = text.normalize('NFKC').replace(/[‘’]/gu, "'").trim()
  if (!source) return null

  if (
    /^(?:please\s+)?forget\s+(?:everything|all|what (?:i|we) (?:told|shared with) you|everything you know)\s*(?:about me)?[.!?]*$/iu.test(
      source
    )
  ) {
    return { kind: 'forget-all' }
  }
  if (
    /^(?:what do you remember about me|what have i told you|what do you know about me|do you remember me|what(?:'s| is) my name)[.!?]*$/iu.test(
      source
    )
  ) {
    return { kind: 'recall' }
  }

  const nameMatch = /^(?:my name is|call me|you can call me|i go by)\s+(.+?)[.!?]*$/iu.exec(source)
  if (nameMatch?.[1]) {
    if (containsAnotherAppAction(nameMatch[1])) return null
    const name = cleanValue(nameMatch[1]).slice(0, 80)
    return name ? { kind: 'set-name', name } : null
  }

  const rememberMatch =
    /^(?:please\s+)?remember\s+(?:that\s+|this\s+about\s+me:\s*)?(.+?)[.!?]*$/iu.exec(source)
  if (rememberMatch?.[1] && !/^to\b/iu.test(rememberMatch[1])) {
    if (containsAnotherAppAction(rememberMatch[1])) return null
    const memory = cleanValue(rememberMatch[1]).slice(0, 500)
    return memory ? { kind: 'remember', memory } : null
  }

  const forgetMatch = /^(?:please\s+)?forget\s+(?:that\s+)?(.+?)[.!?]*$/iu.exec(source)
  if (forgetMatch?.[1]) {
    if (containsAnotherAppAction(forgetMatch[1])) return null
    const memory = cleanValue(forgetMatch[1]).slice(0, 500)
    return memory ? { kind: 'forget', memory } : null
  }
  return null
}
