/// <reference types="vite/client" />

import type { RemindMeBridge } from '@remind-me/contracts'

declare global {
  interface Window {
    remindMe: RemindMeBridge
  }
}

export {}
