import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  canvasAssignmentSchema,
  canvasAssignmentsResponseSchema,
  canvasConnectRequestSchema,
  canvasConnectionStatusSchema,
  type CanvasAssignment,
  type CanvasAssignmentsResponse,
  type CanvasConnectionStatus
} from '@remind-me/contracts'

const requestTimeoutMs = 15_000
const maximumCoursePages = 5
const maximumAssignmentPagesPerCourse = 3
const assignmentsPerPage = 100
const assignmentRequestConcurrency = 4

export interface CanvasCredentialVault {
  isAvailable: () => Promise<boolean>
  encrypt: (value: string) => Promise<string>
  decrypt: (value: string) => Promise<string>
}

type FetchImplementation = (input: URL, init?: RequestInit) => Promise<Response>

interface StoredCanvasConnection {
  version: 1
  instanceUrl: string
  encryptedAccessToken: string
  lastSyncedAt: string | null
  lastError: string | null
}

interface CanvasCourse {
  id: string
  name: string
}

interface CanvasServiceOptions {
  connectionPath: string
  credentialVault: CanvasCredentialVault
  fetchImplementation?: FetchImplementation
}

function friendlyCanvasError(error: unknown): string {
  if (error instanceof CanvasRequestError) return error.message
  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'Canvas took too long to respond. Try again in a moment.'
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return 'Canvas took too long to respond. Try again in a moment.'
  }
  return 'Could not reach Canvas. Check the Canvas address and your connection, then try again.'
}

class CanvasRequestError extends Error {}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function numberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function objectField(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function plainCanvasText(value: string): string {
  return value
    .replace(/<\s*br\s*\/?>/giu, '\n')
    .replace(/<\s*\/p\s*>/giu, '\n')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/[ \t]+([,.;:!?])/gu, '$1')
    .trim()
    .slice(0, 10_000)
}

export function normalizeCanvasInstanceUrl(value: string): string {
  const url = new URL(value.trim())
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error('Enter your Canvas site address, beginning with https://')
  }
  return url.origin
}

function sourceKey(instanceUrl: string, courseId: string, assignmentId: string): string {
  const digest = createHash('sha256')
    .update(`${instanceUrl}\u0000${courseId}\u0000${assignmentId}`)
    .digest('hex')
  return `canvas:${digest}`
}

function nextLink(header: string | null, instanceUrl: string): URL | null {
  if (!header) return null
  const match = /<([^>]+)>;\s*rel="?next"?/iu.exec(header)
  if (!match?.[1]) return null
  const candidate = new URL(match[1], instanceUrl)
  if (candidate.origin !== instanceUrl || !candidate.pathname.startsWith('/api/')) {
    throw new CanvasRequestError('Canvas returned an unsafe next-page link.')
  }
  return candidate
}

function isValidInstant(value: string): boolean {
  const time = Date.parse(value)
  return Number.isFinite(time) && /(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  work: (value: Input) => Promise<Output>
): Promise<Output[]> {
  const results: Output[] = []
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      const value = values[index]
      if (value === undefined) continue
      results[index] = await work(value)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
  return results
}

export class CanvasService {
  private readonly fetchImplementation: FetchImplementation

  constructor(private readonly options: CanvasServiceOptions) {
    this.fetchImplementation = options.fetchImplementation ?? ((input, init) => fetch(input, init))
  }

  async getStatus(): Promise<CanvasConnectionStatus> {
    const stored = await this.readConnection()
    const status = {
      configured: stored !== null,
      instanceUrl: stored?.instanceUrl ?? null,
      credentialStorageAvailable: await this.options.credentialVault.isAvailable(),
      lastSyncedAt: stored?.lastSyncedAt ?? null,
      lastError: stored?.lastError ?? null
    }
    return canvasConnectionStatusSchema.parse(status)
  }

  async connect(input: unknown): Promise<CanvasConnectionStatus> {
    const request = canvasConnectRequestSchema.parse(input)
    if (!(await this.options.credentialVault.isAvailable())) {
      throw new Error(
        'This device cannot protect a Canvas token yet. Enable your operating system credential store, then try again.'
      )
    }
    const instanceUrl = normalizeCanvasInstanceUrl(request.instanceUrl)
    await this.fetchJson(
      new URL('/api/v1/users/self/courses?per_page=1', instanceUrl),
      request.accessToken
    )
    await this.writeConnection({
      version: 1,
      instanceUrl,
      encryptedAccessToken: await this.options.credentialVault.encrypt(request.accessToken),
      lastSyncedAt: null,
      lastError: null
    })
    return this.getStatus()
  }

  async disconnect(): Promise<CanvasConnectionStatus> {
    await rm(this.options.connectionPath, { force: true })
    return this.getStatus()
  }

  async listUpcomingAssignments(): Promise<CanvasAssignmentsResponse> {
    const connection = await this.requiredConnection()
    try {
      const token = await this.options.credentialVault.decrypt(connection.encryptedAccessToken)
      const courses = await this.listCourses(connection.instanceUrl, token)
      const allAssignments = await mapWithConcurrency(
        courses,
        assignmentRequestConcurrency,
        async (course) => this.listCourseAssignments(connection.instanceUrl, token, course)
      )
      const assignmentMap = new Map<string, CanvasAssignment>()
      let withoutDueDateCount = 0
      for (const courseAssignments of allAssignments) {
        withoutDueDateCount += courseAssignments.withoutDueDateCount
        for (const assignment of courseAssignments.assignments) {
          assignmentMap.set(assignment.sourceKey, assignment)
        }
      }
      const fetchedAt = new Date().toISOString()
      await this.writeConnection({ ...connection, lastSyncedAt: fetchedAt, lastError: null })
      return canvasAssignmentsResponseSchema.parse({
        assignments: [...assignmentMap.values()].sort(
          (left, right) => Date.parse(left.dueAtUtc) - Date.parse(right.dueAtUtc)
        ),
        withoutDueDateCount,
        fetchedAt
      })
    } catch (error) {
      const message = friendlyCanvasError(error)
      await this.writeConnection({ ...connection, lastError: message })
      throw new Error(message, { cause: error })
    }
  }

  private async listCourses(instanceUrl: string, token: string): Promise<CanvasCourse[]> {
    const courses = await this.listPages(
      new URL(
        '/api/v1/users/self/courses?enrollment_state=active&include[]=term&per_page=100',
        instanceUrl
      ),
      token,
      maximumCoursePages
    )
    const result = new Map<string, CanvasCourse>()
    for (const rawCourse of courses) {
      const course = objectField(rawCourse)
      const id =
        stringField(course?.id) ?? (typeof course?.id === 'number' ? String(course.id) : null)
      if (!id) continue
      const name = stringField(course?.name) ?? `Course ${id}`
      result.set(id, { id, name: name.slice(0, 500) })
    }
    return [...result.values()]
  }

  private async listCourseAssignments(
    instanceUrl: string,
    token: string,
    course: CanvasCourse
  ): Promise<{ assignments: CanvasAssignment[]; withoutDueDateCount: number }> {
    const path = `/api/v1/users/self/courses/${encodeURIComponent(course.id)}/assignments?bucket=upcoming&order_by=due_at&per_page=${assignmentsPerPage}`
    const rows = await this.listPages(
      new URL(path, instanceUrl),
      token,
      maximumAssignmentPagesPerCourse
    )
    const assignments: CanvasAssignment[] = []
    let withoutDueDateCount = 0
    for (const rawAssignment of rows) {
      const assignment = objectField(rawAssignment)
      const assignmentId =
        stringField(assignment?.id) ??
        (typeof assignment?.id === 'number' ? String(assignment.id) : null)
      const title = stringField(assignment?.name)
      const dueAtUtc = stringField(assignment?.due_at)
      if (!assignmentId || !title) continue
      if (!dueAtUtc || !isValidInstant(dueAtUtc)) {
        withoutDueDateCount += 1
        continue
      }
      const description =
        typeof assignment?.description === 'string' ? plainCanvasText(assignment.description) : ''
      assignments.push(
        canvasAssignmentSchema.parse({
          sourceKey: sourceKey(instanceUrl, course.id, assignmentId),
          assignmentId,
          courseId: course.id,
          courseName: course.name,
          title: title.slice(0, 1_000),
          dueAtUtc,
          description,
          pointsPossible: numberField(assignment?.points_possible),
          importKind: null
        })
      )
    }
    return { assignments, withoutDueDateCount }
  }

  private async listPages(
    initialUrl: URL,
    token: string,
    maximumPages: number
  ): Promise<unknown[]> {
    const rows: unknown[] = []
    let next: URL | null = initialUrl
    for (let page = 0; next !== null && page < maximumPages; page += 1) {
      const response = await this.fetchJson(next, token)
      if (!Array.isArray(response.body)) {
        throw new CanvasRequestError(
          'Canvas returned an unexpected response. Reconnect and try again.'
        )
      }
      rows.push(...response.body)
      next = nextLink(response.link, next.origin)
    }
    return rows
  }

  private async fetchJson(
    url: URL,
    accessToken: string
  ): Promise<{ body: unknown; link: string | null }> {
    let response: Response
    try {
      response = await this.fetchImplementation(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(requestTimeoutMs)
      })
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'TimeoutError')
      ) {
        throw error
      }
      throw new CanvasRequestError(
        'Could not reach Canvas. Check the Canvas address and your connection, then try again.'
      )
    }
    if (response.status === 401 || response.status === 403) {
      throw new CanvasRequestError(
        'Canvas rejected the token. Create a new token in Canvas, then reconnect here.'
      )
    }
    if (response.status === 429) {
      throw new CanvasRequestError('Canvas is busy right now. Wait a moment, then refresh again.')
    }
    if (response.status >= 300 && response.status < 400) {
      throw new CanvasRequestError(
        'Canvas redirected this request. Check that the site address is correct.'
      )
    }
    if (!response.ok) {
      throw new CanvasRequestError(
        'Canvas is temporarily unavailable. Try refreshing again shortly.'
      )
    }
    try {
      return { body: await response.json(), link: response.headers.get('link') }
    } catch {
      throw new CanvasRequestError(
        'Canvas returned unreadable data. Try reconnecting your account.'
      )
    }
  }

  private async requiredConnection(): Promise<StoredCanvasConnection> {
    const connection = await this.readConnection()
    if (!connection) throw new Error('Connect Canvas first to see assignment due dates.')
    if (!(await this.options.credentialVault.isAvailable())) {
      throw new Error('This device cannot access its protected Canvas token right now.')
    }
    return connection
  }

  private async readConnection(): Promise<StoredCanvasConnection | null> {
    try {
      const raw = await readFile(this.options.connectionPath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      const value = objectField(parsed)
      if (
        value?.version !== 1 ||
        typeof value.instanceUrl !== 'string' ||
        typeof value.encryptedAccessToken !== 'string' ||
        (value.lastSyncedAt !== null && typeof value.lastSyncedAt !== 'string') ||
        (value.lastError !== null && typeof value.lastError !== 'string')
      ) {
        throw new Error('Invalid Canvas connection')
      }
      return {
        version: 1,
        instanceUrl: normalizeCanvasInstanceUrl(value.instanceUrl),
        encryptedAccessToken: value.encryptedAccessToken,
        lastSyncedAt: value.lastSyncedAt,
        lastError: value.lastError
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw new Error(
        'Your saved Canvas connection could not be read. Reconnect Canvas to repair it.',
        {
          cause: error
        }
      )
    }
  }

  private async writeConnection(connection: StoredCanvasConnection): Promise<void> {
    await mkdir(dirname(this.options.connectionPath), { recursive: true })
    const temporaryPath = `${this.options.connectionPath}.next`
    await writeFile(temporaryPath, JSON.stringify(connection), { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, this.options.connectionPath)
  }
}
