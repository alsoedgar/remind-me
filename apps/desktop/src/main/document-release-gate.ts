import { app, type BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'

interface DocumentGateExpectedItem {
  kind: 'event' | 'reminder'
  title: string
  startDate: string
  endDate: string | null
  startTime: string | null
  endTime: string | null
  location: string | null
  allDay: boolean
  recurrence: unknown
  schedule: unknown
}

interface DocumentGateInput {
  caseId: string
  inputClass: string
  expectedExtraction: 'native-text' | 'ocr' | 'mixed'
  expectedItems: DocumentGateExpectedItem[]
}

function gateInput(): DocumentGateInput {
  const raw = process.env.REMIND_ME_DOCUMENT_GATE_EXPECTED
  if (!raw) throw new Error('REMIND_ME_DOCUMENT_GATE_EXPECTED is required')
  const value = JSON.parse(raw) as Partial<DocumentGateInput>
  if (
    typeof value.caseId !== 'string' ||
    typeof value.inputClass !== 'string' ||
    !['native-text', 'ocr', 'mixed'].includes(value.expectedExtraction ?? '') ||
    !Array.isArray(value.expectedItems) ||
    value.expectedItems.length === 0
  ) {
    throw new Error('The packaged document gate input is invalid')
  }
  return value as DocumentGateInput
}

async function writeGateReport(path: string, report: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

export function scheduleDocumentReleaseGate(window: BrowserWindow): void {
  const reportPath = process.env.REMIND_ME_DOCUMENT_GATE_REPORT
  const startedAt = new Date().toISOString()
  const started = performance.now()
  const timeout = setTimeout(() => {
    console.error('Packaged document release gate timed out.')
    app.exit(1)
  }, 300_000)

  window.webContents.once('did-finish-load', async () => {
    let input: DocumentGateInput | null = null
    try {
      if (!reportPath) throw new Error('REMIND_ME_DOCUMENT_GATE_REPORT is required')
      input = gateInput()
      window.showInactive()
      const result = (await window.webContents.executeJavaScript(`
        (async () => {
          const expected = ${JSON.stringify(input)}
          const packagedRuntime = ${JSON.stringify(app.isPackaged)}
          const offlineRuntime = ${JSON.stringify(process.argv.includes('--offline-smoke'))}
          const range = {
            rangeStartUtc: '2026-01-01T00:00:00.000Z',
            rangeEndUtc: '2027-01-01T00:00:00.000Z'
          }
          const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
          const waitFor = async (predicate, label, milliseconds = 180000) => {
            const deadline = Date.now() + milliseconds
            while (Date.now() < deadline) {
              const value = predicate()
              if (value) return value
              const documentError = document.querySelector('.document-error[role="alert"]')
              if (documentError) throw new Error(label + ': ' + documentError.textContent.trim())
              await sleep(50)
            }
            throw new Error('Timed out waiting for ' + label)
          }
          const normalize = (value) => String(value ?? '').trim().replace(/\\s+/gu, ' ').toLocaleLowerCase()
          const stable = (value) => {
            if (Array.isArray(value)) return value.map(stable)
            if (value && typeof value === 'object') {
              return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
            }
            return value
          }
          const equal = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right))
          const parseData = (value) => value ? JSON.parse(value) : null
          const click = (node, label) => {
            if (!(node instanceof HTMLElement)) throw new Error('Missing control: ' + label)
            node.click()
          }
          const setInput = (input, value) => {
            if (!(input instanceof HTMLInputElement)) throw new Error('Missing editable title input')
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            if (!setter) throw new Error('The browser input setter is unavailable')
            setter.call(input, value)
            input.dispatchEvent(new Event('input', { bubbles: true }))
            input.dispatchEvent(new Event('change', { bubbles: true }))
          }
          const cards = () => [...document.querySelectorAll('[data-testid="document-draft-card"]')]
          const detailsButton = () => document.querySelector('[data-review-view="details"]')
          const sourceButton = () => document.querySelector('[data-review-view="source"]')
          const activateCard = async (index) => {
            click(detailsButton(), 'Edit details tab')
            await waitFor(() => detailsButton()?.getAttribute('data-active') === 'true', 'details view')
            const card = cards()[index]
            if (!(card instanceof HTMLElement)) throw new Error('Missing proposal card ' + (index + 1))
            click(card.querySelector('.document-draft-summary'), 'proposal ' + (index + 1))
            await waitFor(
              () => cards()[index]?.getAttribute('data-active') === 'true',
              'active proposal ' + (index + 1)
            )
            return cards()[index]
          }
          const fieldValue = (card, suffix) => {
            const input = card.querySelector('input[id$="-' + suffix + '"]')
            return input instanceof HTMLInputElement ? input.value : null
          }
          const inspectDraft = async (index) => {
            const card = await activateCard(index)
            const kind = card.getAttribute('data-draft-kind')
            const title = fieldValue(card, 'title')
            const recurrence = parseData(card.getAttribute('data-draft-recurrence'))
            const schedule = parseData(card.getAttribute('data-draft-schedule'))
            if (kind === 'event') {
              const allDay = card.querySelector('.document-check-label input')
              return {
                kind,
                title,
                startDate: fieldValue(card, 'start-date'),
                endDate: fieldValue(card, 'end-date'),
                startTime: fieldValue(card, 'start-time'),
                endTime: fieldValue(card, 'end-time'),
                location: fieldValue(card, 'location') || null,
                allDay: allDay instanceof HTMLInputElement ? allDay.checked : false,
                recurrence,
                schedule
              }
            }
            return {
              kind,
              title,
              startDate: fieldValue(card, 'due-date'),
              endDate: null,
              startTime: fieldValue(card, 'due-time'),
              endTime: null,
              location: null,
              allDay: false,
              recurrence,
              schedule
            }
          }
          const scheduleMatches = (actual, wanted) => {
            if (wanted === null) return actual === null
            if (!actual || typeof wanted !== 'object') return false
            return ['courseCode', 'sectionCode', 'crn', 'component'].every(
              (key) => wanted[key] === undefined || equal(actual[key] ?? null, wanted[key] ?? null)
            )
          }
          const itemMatches = (actual, wanted) =>
            actual.kind === wanted.kind &&
            normalize(actual.title) === normalize(wanted.title) &&
            actual.startDate === wanted.startDate &&
            actual.endDate === wanted.endDate &&
            actual.startTime === wanted.startTime &&
            actual.endTime === wanted.endTime &&
            normalize(actual.location) === normalize(wanted.location) &&
            actual.allDay === wanted.allDay &&
            equal(actual.recurrence, wanted.recurrence) &&
            scheduleMatches(actual.schedule, wanted.schedule)

          await waitFor(
            () => window.remindMe && document.querySelector('[data-testid="document-import-button"]'),
            'application bridge'
          )
          const appInfo = await window.remindMe.getAppInfo()
          const initial = await window.remindMe.getCalendarSnapshot(range)
          click(document.querySelector('[data-testid="document-import-button"]'), 'Import plan')
          await waitFor(
            () => document.querySelector('[data-testid="document-review"]'),
            'document worker review'
          )

          const proposalCount = cards().length
          const selectedInitially = cards().filter((card) => card.getAttribute('data-selected') === 'true').length
          const observedItems = []
          for (let index = 0; index < proposalCount; index += 1) {
            observedItems.push(await inspectDraft(index))
          }
          const unmatchedExpected = [...expected.expectedItems]
          let exactMatches = 0
          for (const actual of observedItems) {
            const matchIndex = unmatchedExpected.findIndex((wanted) => itemMatches(actual, wanted))
            if (matchIndex >= 0) {
              exactMatches += 1
              unmatchedExpected.splice(matchIndex, 1)
            }
          }

          const evidenceChecks = []
          for (let index = 0; index < proposalCount; index += 1) {
            await activateCard(index)
            click(sourceButton(), 'Source tab')
            const panel = await waitFor(
              () => {
                const candidate = document.querySelector('[data-testid="document-evidence-panel"]')
                return candidate instanceof HTMLElement && !candidate.hidden ? candidate : null
              },
              'visible evidence panel'
            )
            const image = await waitFor(
              () => {
                const candidate = document.querySelector('[data-testid="document-source-image"]')
                return candidate instanceof HTMLImageElement && candidate.complete && candidate.naturalWidth > 0
                  ? candidate
                  : null
              },
              'source image'
            )
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            const overlay = document.querySelector('.document-evidence-overlay')
            const overlayRect = overlay?.getBoundingClientRect()
            const highlights = [...(overlay?.querySelectorAll('span') ?? [])]
            const alignedHighlights = overlayRect
              ? highlights.filter((highlight) => {
                  const rectangle = highlight.getBoundingClientRect()
                  return (
                    rectangle.width > 0 &&
                    rectangle.height > 0 &&
                    rectangle.left >= overlayRect.left - 2 &&
                    rectangle.top >= overlayRect.top - 2 &&
                    rectangle.right <= overlayRect.right + 2 &&
                    rectangle.bottom <= overlayRect.bottom + 2
                  )
                }).length
              : 0
            evidenceChecks.push({
              draftIndex: index,
              extraction: panel.getAttribute('data-extraction'),
              imageWidth: image.naturalWidth,
              imageHeight: image.naturalHeight,
              highlights: highlights.length,
              alignedHighlights,
              citedBlocks: panel.querySelectorAll('blockquote').length
            })
          }

          const firstCard = await activateCard(0)
          const selection = firstCard.querySelector('.document-draft-select input')
          if (!(selection instanceof HTMLInputElement)) throw new Error('Proposal selection control is missing')
          const selectedBeforeToggle = selection.checked
          selection.click()
          await waitFor(() => cards()[0]?.getAttribute('data-selected') === 'false', 'proposal deselection')
          cards()[0]?.querySelector('.document-draft-select input')?.click()
          await waitFor(() => cards()[0]?.getAttribute('data-selected') === 'true', 'proposal reselection')
          const selectionRoundTrip = cards()[0]?.getAttribute('data-selected') === 'true'

          const editableCard = await activateCard(0)
          const titleInput = editableCard.querySelector('input[id$="-title"]')
          if (!(titleInput instanceof HTMLInputElement)) throw new Error('Proposal title editor is missing')
          const originalTitle = titleInput.value
          const editedTitle = originalTitle + ' release gate edit'
          setInput(titleInput, editedTitle)
          await waitFor(
            () => cards()[0]?.getAttribute('data-draft-title') === editedTitle,
            'proposal edit propagation'
          )
          const updatedTitleInput = cards()[0]?.querySelector('input[id$="-title"]')
          setInput(updatedTitleInput, originalTitle)
          await waitFor(
            () => cards()[0]?.getAttribute('data-draft-title') === originalTitle,
            'proposal edit restoration'
          )
          const editRoundTrip = cards()[0]?.getAttribute('data-draft-title') === originalTitle

          const beforeConfirmation = await window.remindMe.getCalendarSnapshot(range)
          const confirm = document.querySelector('[data-testid="document-confirm"]')
          click(confirm, 'Add selected items')
          await waitFor(() => !document.querySelector('[data-testid="document-dialog"]'), 'atomic commit')
          const imported = await window.remindMe.getCalendarSnapshot(range)
          const importedEntities = [...imported.events, ...imported.reminders]
          const importedTitles = importedEntities.map((entity) => normalize(entity.title)).sort()
          const expectedTitles = expected.expectedItems.map((item) => normalize(item.title)).sort()
          const importedIdentityComplete = importedEntities.every(
            (entity) => entity.provenance === 'import' && entity.importIdentity?.sourceRowId
          )

          click(document.querySelector('[data-testid="document-import-button"]'), 'Import plan again')
          await waitFor(
            () => document.querySelector('[data-testid="document-review"]'),
            'duplicate reconciliation review'
          )
          const duplicateCards = cards()
          const duplicateSnapshot = await window.remindMe.getCalendarSnapshot(range)
          const duplicateConfirm = document.querySelector('[data-testid="document-confirm"]')
          const duplicateProtected =
            duplicateCards.length === expected.expectedItems.length &&
            duplicateCards.every(
              (card) =>
                card.getAttribute('data-reconciliation') === 'same-source' &&
                card.getAttribute('data-selected') === 'false'
            ) &&
            duplicateConfirm instanceof HTMLButtonElement &&
            duplicateConfirm.disabled
          click(document.querySelector('[data-testid="document-close"]'), 'Close duplicate review')
          await waitFor(() => !document.querySelector('[data-testid="document-dialog"]'), 'duplicate review close')

          const undone = await window.remindMe.undoLastAction(range)
          const evidenceAligned =
            evidenceChecks.length === expected.expectedItems.length &&
            evidenceChecks.every(
              (check) =>
                check.extraction === expected.expectedExtraction &&
                check.imageWidth > 0 &&
                check.imageHeight > 0 &&
                check.highlights > 0 &&
                check.alignedHighlights === check.highlights &&
                check.citedBlocks > 0
            )
          const checks = {
            packagedRuntime,
            offlineRuntime,
            localReleaseReady: appInfo.offlineReady === true,
            noFabricatedProposals:
              proposalCount === expected.expectedItems.length && exactMatches === proposalCount,
            exactFieldPlacement:
              exactMatches === expected.expectedItems.length && unmatchedExpected.length === 0,
            selectedByDefault: selectedInitially === expected.expectedItems.length,
            visibleEvidenceAlignment: evidenceAligned,
            selectionRoundTrip: selectedBeforeToggle && selectionRoundTrip,
            editRoundTrip,
            explicitConfirmation:
              initial.events.length === 0 &&
              initial.reminders.length === 0 &&
              beforeConfirmation.events.length === 0 &&
              beforeConfirmation.reminders.length === 0,
            atomicCommit:
              importedEntities.length === expected.expectedItems.length &&
              equal(importedTitles, expectedTitles) &&
              importedIdentityComplete &&
              imported.canUndo === true,
            duplicateReconciliation:
              duplicateProtected &&
              duplicateSnapshot.events.length === imported.events.length &&
              duplicateSnapshot.reminders.length === imported.reminders.length,
            singleUndo:
              undone.snapshot.events.length === 0 &&
              undone.snapshot.reminders.length === 0
          }
          const failures = Object.entries(checks)
            .filter(([, passed]) => !passed)
            .map(([name]) => name)
          return {
            passed: failures.length === 0,
            failures,
            checks,
            metrics: {
              expectedItems: expected.expectedItems.length,
              observedItems: proposalCount,
              exactMatches,
              proposalPrecision: proposalCount === 0 ? 0 : exactMatches / proposalCount,
              proposalRecall: exactMatches / expected.expectedItems.length,
              evidenceItems: evidenceChecks.filter(
                (check) => check.highlights > 0 && check.alignedHighlights === check.highlights
              ).length,
              evidenceCoverage: evidenceChecks.length / expected.expectedItems.length
            },
            observedItems,
            evidenceChecks
          }
        })()
      `)) as { passed: boolean; failures: string[] }

      const report = {
        schemaVersion: 1,
        caseId: input.caseId,
        inputClass: input.inputClass,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - started),
        runtime: {
          platform: process.platform,
          arch: process.arch,
          packaged: app.isPackaged,
          offline: process.argv.includes('--offline-smoke')
        },
        ...result
      }
      await writeGateReport(reportPath, report)
      clearTimeout(timeout)
      if (!result.passed)
        console.error(`Document release assertions failed: ${result.failures.join(', ')}`)
      app.exit(result.passed ? 0 : 1)
    } catch (error) {
      clearTimeout(timeout)
      const message = error instanceof Error ? error.message : String(error)
      console.error('Packaged document release gate failed.', error)
      if (reportPath) {
        await writeGateReport(reportPath, {
          schemaVersion: 1,
          caseId: input?.caseId ?? 'unknown',
          inputClass: input?.inputClass ?? 'unknown',
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Math.round(performance.now() - started),
          runtime: {
            platform: process.platform,
            arch: process.arch,
            packaged: app.isPackaged,
            offline: process.argv.includes('--offline-smoke')
          },
          passed: false,
          failures: ['runtime-error'],
          error: message
        }).catch((writeError: unknown) => {
          console.error('Could not write the failed document gate report.', writeError)
        })
      }
      app.exit(1)
    }
  })

  window.webContents.once('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    clearTimeout(timeout)
    console.error(
      `Packaged document gate failed to load ${validatedUrl}: ${errorCode} ${errorDescription}`
    )
    app.exit(1)
  })
}
