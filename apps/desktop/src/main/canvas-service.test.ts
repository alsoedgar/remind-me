import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { CanvasService, type CanvasCredentialVault } from './canvas-service'

const directories: string[] = []

const vault: CanvasCredentialVault = {
  isAvailable: async () => true,
  encrypt: async (value) =>
    Buffer.from(value, 'utf8').toString('base64').split('').reverse().join(''),
  decrypt: async (value) =>
    Buffer.from(value.split('').reverse().join(''), 'base64').toString('utf8')
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

async function connectionPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'remind-me-canvas-service-'))
  directories.push(directory)
  return join(directory, 'canvas-connection-v1.json')
}

describe('CanvasService', () => {
  it('keeps the token out of the connection file and reads upcoming due dates only', async () => {
    const requests: URL[] = []
    const path = await connectionPath()
    const service = new CanvasService({
      connectionPath: path,
      credentialVault: vault,
      fetchImplementation: async (url, init) => {
        requests.push(url)
        expect(init?.method).toBe('GET')
        expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
          'Bearer private-token'
        )
        if (url.pathname === '/api/v1/users/self/courses') {
          return new Response(
            JSON.stringify([
              { id: 44, name: 'Calculus III' },
              { id: 45, name: 'Data Structures' }
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        if (url.pathname.endsWith('/courses/44/assignments')) {
          return new Response(
            JSON.stringify([
              {
                id: 1,
                name: 'Midterm',
                due_at: '2026-10-31T23:30:00.000Z',
                description: '<p>Bring a <strong>pencil</strong>.</p>',
                points_possible: 100
              },
              { id: 2, name: 'No date yet', due_at: null }
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        if (url.pathname.endsWith('/courses/45/assignments')) {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        }
        return new Response('not found', { status: 404 })
      }
    })

    const connected = await service.connect({
      instanceUrl: 'https://canvas.example.edu/',
      accessToken: 'private-token'
    })
    expect(connected).toMatchObject({
      configured: true,
      instanceUrl: 'https://canvas.example.edu',
      credentialStorageAvailable: true
    })

    const rawConnection = await readFile(path, 'utf8')
    expect(rawConnection).not.toContain('private-token')

    const response = await service.listUpcomingAssignments()
    expect(response).toMatchObject({
      withoutDueDateCount: 1,
      assignments: [
        {
          assignmentId: '1',
          courseId: '44',
          courseName: 'Calculus III',
          title: 'Midterm',
          description: 'Bring a pencil.',
          pointsPossible: 100,
          importKind: null
        }
      ]
    })
    expect(response.assignments[0]?.sourceKey).toMatch(/^canvas:[a-f0-9]{64}$/u)
    expect(requests.every((url) => url.origin === 'https://canvas.example.edu')).toBe(true)
    await expect(service.getStatus()).resolves.toMatchObject({ lastSyncedAt: expect.any(String) })
  })

  it('does not save a rejected token', async () => {
    const path = await connectionPath()
    const service = new CanvasService({
      connectionPath: path,
      credentialVault: vault,
      fetchImplementation: async () => new Response('nope', { status: 401 })
    })

    await expect(
      service.connect({
        instanceUrl: 'https://canvas.example.edu',
        accessToken: 'bad-token'
      })
    ).rejects.toThrow('Canvas rejected the token')
    await expect(service.getStatus()).resolves.toMatchObject({ configured: false })
  })

  it('refuses to persist a token without protected credential storage', async () => {
    const service = new CanvasService({
      connectionPath: await connectionPath(),
      credentialVault: {
        isAvailable: async () => false,
        encrypt: async () => {
          throw new Error('not used')
        },
        decrypt: async () => {
          throw new Error('not used')
        }
      },
      fetchImplementation: async () => new Response('not used')
    })

    await expect(
      service.connect({
        instanceUrl: 'https://canvas.example.edu',
        accessToken: 'private-token'
      })
    ).rejects.toThrow('cannot protect a Canvas token')
    await expect(service.getStatus()).resolves.toMatchObject({
      configured: false,
      credentialStorageAvailable: false
    })
  })
})
