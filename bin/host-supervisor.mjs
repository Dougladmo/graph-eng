import { spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'

// Private bootstrap for createHost. Its process is detached and remains the
// leader of the CLI's group until it signals that group itself.
const GRACE_MS = 1000
let cli
let started = false
let draining = false
let exited = false
let localTimer
let forwardingClosed = false
const pendingWrites = new Set()
const stdinBuffer = new PassThrough()
process.stdin.pipe(stdinBuffer)
const bootstrapTimeout = Number(process.argv[2])
if (Number.isFinite(bootstrapTimeout) && bootstrapTimeout > 0) localTimer = setTimeout(() => drain('timeout'), bootstrapTimeout)

function send(message, callback = () => {}) {
  try { if (process.connected) process.send(message, callback); else callback(new Error('IPC desconectado')) } catch (error) { callback(error) }
}

function drain(reason) {
  if (draining) return
  draining = true
  if (reason === 'timeout') send({ type: 'timeout' })
  if (cli && !exited) {
    try { cli.stdin?.destroy() } catch {}
  }
  try { process.kill(-process.pid, 'SIGTERM') } catch (error) {
    if (error.code !== 'ESRCH') send({ type: 'supervisorError', reason, message: error.message })
  }
  // The CLI is in this process group. Keep this leader alive through the
  // grace period, then signal the group from a member whose identity cannot
  // have been recycled while the signal is issued.
  setTimeout(async () => {
    const flushUntil = Date.now() + 250
    while (Date.now() < flushUntil) {
      cli?.stdout?.resume()
      cli?.stderr?.resume()
      const unreadBytes = (cli?.stdout?.readableLength ?? 0) + (cli?.stderr?.readableLength ?? 0)
      if (!pendingWrites.size && !unreadBytes) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    forwardingClosed = true
    cli?.stdout?.pause()
    cli?.stderr?.pause()
    const unreadBytes = (cli?.stdout?.readableLength ?? 0) + (cli?.stderr?.readableLength ?? 0)
    const flushed = pendingWrites.size === 0 && unreadBytes === 0
    if (!flushed) send({ type: 'supervisorError', reason, message: 'limite de flush dos pipes excedido' })
    send({ type: 'drainAck', flushed }, () => {
      try { process.kill(-process.pid, 'SIGKILL') } catch (error) {
        send({ type: 'supervisorError', reason, message: error.message })
        process.exitCode = 1
        try { process.disconnect() } catch {}
      }
    })
  }, GRACE_MS)
}

process.on('SIGTERM', () => {})
process.stdin.on('error', error => {
  send({ type: 'stdinError', message: error.message })
  drain('stdin-error')
})
process.on('disconnect', () => drain('disconnect'))
process.on('message', message => {
  if (!message || typeof message !== 'object') return drain('invalid-message')
  if (message.type === 'start') {
    if (started || draining || typeof message.command !== 'string' || !Array.isArray(message.args) || typeof message.cwd !== 'string' || !Number.isFinite(message.timeoutMs) || message.timeoutMs <= 0) return drain('invalid-start')
    started = true
    clearTimeout(localTimer)
    localTimer = setTimeout(() => drain('timeout'), message.timeoutMs)
    try {
      cli = spawn(message.command, message.args, { cwd: message.cwd, shell: false, detached: false, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      send({ type: 'cliError', code: error.code, message: error.message })
      exited = true
      return drain('spawn-failed')
    }
    const forward = (source, destination) => source?.on('data', chunk => {
      source.pause()
      let finishWrite
      const pending = new Promise(resolve => { finishWrite = resolve })
      pendingWrites.add(pending)
      destination.write(chunk, error => {
        if (error) send({ type: 'streamError', message: error.message })
        pendingWrites.delete(pending)
        finishWrite()
        if (!forwardingClosed) source.resume()
      })
    })
    forward(cli.stdout, process.stdout)
    forward(cli.stderr, process.stderr)
    stdinBuffer.pipe(cli.stdin)
    cli.stdin?.on('error', error => send({ type: 'stdinError', message: error.message }))
    cli.stdout?.on('error', error => send({ type: 'streamError', message: error.message }))
    cli.stderr?.on('error', error => send({ type: 'streamError', message: error.message }))
    cli.on('error', error => {
      send({ type: 'cliError', code: error.code, message: error.message })
      exited = true
      drain('cli-error')
    })
    cli.on('exit', (code, signal) => {
      exited = true
      clearTimeout(localTimer)
      send({ type: 'cliExit', code, signal })
      drain('cli-exit')
    })
    return
  }
  if (message.type === 'terminate') drain(message.reason ?? 'terminate')
  else drain('invalid-message')
})

process.on('uncaughtException', error => {
  send({ type: 'supervisorError', message: error.message })
  drain('uncaught-exception')
})
process.on('unhandledRejection', error => {
  send({ type: 'supervisorError', message: String(error?.message ?? error) })
  drain('unhandled-rejection')
})

send({ type: 'ready' })
