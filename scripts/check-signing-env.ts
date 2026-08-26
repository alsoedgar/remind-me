const target = process.argv[2]
const required =
  target === 'windows'
    ? ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']
    : target === 'macos'
      ? ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
      : []
const missing = required.filter((name) => !process.env[name]?.trim())
if (missing.length > 0) {
  throw new Error(`A tagged ${target} release requires signing secrets: ${missing.join(', ')}`)
}
console.log(`${target} signing/notarization credentials are present.`)
