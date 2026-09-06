import { useEffect, useState, type ReactNode } from 'react'
import { defaultOnlineAiModel, type OnlineAiStatus } from '@remind-me/contracts'

export function OnlineAiConnection(): ReactNode {
  const [status, setStatus] = useState<OnlineAiStatus | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(defaultOnlineAiModel)
  const [useForAssistant, setUseForAssistant] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void window.remindMe
      .getOnlineAiStatus()
      .then((next) => {
        if (active) setStatus(next)
      })
      .catch(() => {
        if (active) setError('Could not read the AI connection status.')
      })
    return () => {
      active = false
    }
  }, [])

  const run = async (action: () => Promise<OnlineAiStatus>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await action())
      window.dispatchEvent(new Event('remind-me:online-ai-changed'))
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message.replace(/^Error invoking remote method '[^']+': Error: /u, '')
          : 'The AI connection could not be updated.'
      )
    } finally {
      setBusy(false)
      setApiKey('')
    }
  }

  return (
    <section
      className="paper-card settings-section online-ai-settings"
      aria-labelledby="online-ai-heading"
    >
      <p className="eyebrow">Optional online assistance</p>
      <h2 id="online-ai-heading">Connect OpenAI</h2>
      <p className="settings-note">
        Use your OpenAI API account for complex requests and visual document review. An API key and
        API billing are required. ChatGPT sign-in is a separate integration.
      </p>
      {status?.configured ? (
        <div className="online-ai-connection-details">
          <p role="status">Connected to OpenAI · {status.model}</p>
          <label className="check-label">
            <input
              type="checkbox"
              checked={status.useForAssistant}
              disabled={busy}
              onChange={(event) =>
                void run(() =>
                  window.remindMe.configureOnlineAi({ useForAssistant: event.target.checked })
                )
              }
            />
            Use OpenAI for complex assistant requests
          </label>
          <p className="settings-note">
            When enabled, requests, recent conversation, approved profile details and relevant
            calendar facts may be sent to OpenAI. Simple commands stay local. Document pages are
            sent only when you choose “Send pages to OpenAI” in a document review.
          </p>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void run(() => window.remindMe.disconnectOnlineAi())}
          >
            {busy ? 'Updating…' : 'Disconnect OpenAI'}
          </button>
        </div>
      ) : (
        <form
          className="editor-form"
          onSubmit={(event) => {
            event.preventDefault()
            void run(() => window.remindMe.connectOnlineAi({ apiKey, model, useForAssistant }))
          }}
        >
          <label className="full-field">
            OpenAI API key
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              required
              minLength={20}
              maxLength={512}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Your API key"
            />
          </label>
          <label className="full-field">
            Model
            <input
              required
              maxLength={100}
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={useForAssistant}
              onChange={(event) => setUseForAssistant(event.target.checked)}
            />
            Send complex assistant requests and relevant conversation/calendar context to OpenAI
          </label>
          <p className="settings-note">
            Your key is protected by your operating system and excluded from backups. Document
            uploads are a separate choice. All proposed event batches can be reviewed and undone.
          </p>
          {status && !status.credentialStorageAvailable ? (
            <p role="alert">
              Enable your operating system credential store to protect the API key.
            </p>
          ) : null}
          <div>
            <button
              type="submit"
              className="retro-button"
              disabled={busy || !status?.credentialStorageAvailable}
            >
              {busy ? 'Verifying…' : 'Connect and verify'}
            </button>
          </div>
        </form>
      )}
      {error || status?.lastError ? (
        <p className="editor-inline-note" role="alert">
          {error ?? status?.lastError}
        </p>
      ) : null}
    </section>
  )
}
