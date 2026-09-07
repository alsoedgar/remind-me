import { spawn } from 'node:child_process'
import electron from 'electron'
import process from 'node:process'

const args = [
  ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
  '.',
  '--smoke-test',
  '--offline-smoke'
]
const child = spawn(electron, args, { stdio: 'inherit', windowsHide: true })

child.once('error', (error) => {
  process.stderr.write(`${error}\n`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal) {
    process.stderr.write(`Smoke test exited from signal ${signal}\n`)
    process.exitCode = 1
    return
  }
  process.exitCode = code ?? 1
})
