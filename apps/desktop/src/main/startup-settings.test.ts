import { describe, expect, it, vi } from 'vitest'
import {
  applyLaunchAtLogin,
  startupArgumentForMode,
  startupModeFromArguments
} from './startup-settings'

describe('desktop startup settings', () => {
  it('round-trips explicit startup window arguments', () => {
    expect(startupArgumentForMode('glance')).toBe('--startup-glance')
    expect(startupModeFromArguments(['Remind Me.exe', '--startup-widget'])).toBe('widget')
    expect(startupModeFromArguments(['Remind Me.exe'])).toBeNull()
  })

  it('registers the packaged Windows executable with the requested compact mode', () => {
    const setLoginItemSettings = vi.fn()
    expect(
      applyLaunchAtLogin(
        { isPackaged: true, setLoginItemSettings },
        { launchAtLogin: true, startupWindowMode: 'glance' },
        { platform: 'win32', executablePath: 'C:\\Apps\\Remind Me.exe' }
      )
    ).toBe(true)
    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      path: 'C:\\Apps\\Remind Me.exe',
      args: ['--startup-glance']
    })
  })

  it('does not register a development executable', () => {
    const setLoginItemSettings = vi.fn()
    expect(
      applyLaunchAtLogin(
        { isPackaged: false, setLoginItemSettings },
        { launchAtLogin: true, startupWindowMode: 'widget' },
        { platform: 'win32' }
      )
    ).toBe(false)
    expect(setLoginItemSettings).not.toHaveBeenCalled()
  })
})
