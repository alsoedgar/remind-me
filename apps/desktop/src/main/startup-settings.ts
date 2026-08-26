import type { AppWindowMode, PreferencesEntity } from '@remind-me/contracts'

const startupArguments: Readonly<Record<AppWindowMode, string>> = {
  full: '--startup-full',
  widget: '--startup-widget',
  glance: '--startup-glance'
}

interface LoginItemApplication {
  isPackaged: boolean
  setLoginItemSettings: (settings: { openAtLogin: boolean; path?: string; args?: string[] }) => void
}

export function startupArgumentForMode(mode: AppWindowMode): string {
  return startupArguments[mode]
}

export function startupModeFromArguments(argv: readonly string[]): AppWindowMode | null {
  for (const [mode, argument] of Object.entries(startupArguments) as Array<
    [AppWindowMode, string]
  >) {
    if (argv.includes(argument)) return mode
  }
  return null
}

export function applyLaunchAtLogin(
  application: LoginItemApplication,
  preferences: Pick<PreferencesEntity, 'launchAtLogin' | 'startupWindowMode'>,
  options: { platform?: NodeJS.Platform; executablePath?: string } = {}
): boolean {
  const platform = options.platform ?? process.platform
  if (!application.isPackaged || (platform !== 'win32' && platform !== 'darwin')) return false
  if (platform === 'win32') {
    application.setLoginItemSettings({
      openAtLogin: preferences.launchAtLogin,
      path: options.executablePath ?? process.execPath,
      args: preferences.launchAtLogin ? [startupArgumentForMode(preferences.startupWindowMode)] : []
    })
  } else {
    application.setLoginItemSettings({ openAtLogin: preferences.launchAtLogin })
  }
  return true
}
