import { readFile, stat } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('desktop application icon contract', () => {
  it('packages the branded icon and assigns it to every BrowserWindow', async () => {
    const [builderConfig, mainSource, png, ico, icns] = await Promise.all([
      readFile(new URL('../../electron-builder.yml', import.meta.url), 'utf8'),
      readFile(new URL('./index.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../resources/icon.png', import.meta.url)),
      readFile(new URL('../../resources/icon.ico', import.meta.url)),
      readFile(new URL('../../resources/icon.icns', import.meta.url))
    ])

    expect(builderConfig).toContain('from: resources/icon.png')
    expect(builderConfig).toContain('to: app-icon.png')
    expect(builderConfig).toContain('from: resources/icon.ico')
    expect(builderConfig).toContain('to: app-icon.ico')
    expect(builderConfig).toContain('icon: icon.ico')
    expect(builderConfig).toContain('icon: icon.icns')
    expect(builderConfig).toContain('icon: icon.png')
    expect(mainSource).toContain("process.platform === 'win32' ? 'app-icon.ico' : 'app-icon.png'")
    expect(mainSource).toContain("process.platform === 'win32' ? 'icon.ico' : 'icon.png'")
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(8)
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns')
  })

  it('sets the Windows application identity before acquiring the instance lock', async () => {
    const mainSource = await readFile(new URL('./index.ts', import.meta.url), 'utf8')
    const identityCall = mainSource.indexOf('app.setAppUserModelId(windowsAppUserModelId)')
    const instanceLock = mainSource.indexOf('app.requestSingleInstanceLock()')

    expect(identityCall).toBeGreaterThan(0)
    expect(instanceLock).toBeGreaterThan(identityCall)
    expect(mainSource).toContain("const windowsAppUserModelId = 'com.remindme.desktop'")
  })

  it('keeps every generated icon artifact non-trivial', async () => {
    const sizes = await Promise.all(
      ['icon.png', 'icon.ico', 'icon.icns'].map(
        async (name) => (await stat(new URL(`../../resources/${name}`, import.meta.url))).size
      )
    )
    expect(sizes.every((size) => size > 10_000)).toBe(true)
  })
})
