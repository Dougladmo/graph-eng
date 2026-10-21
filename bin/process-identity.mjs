import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import { readFile } from 'node:fs/promises'

const execFileAsync = promisify(execFile)

export function localHostIdentity() {
  return `${process.platform}:${os.hostname()}`
}

export async function processIdentity({ pid = process.pid, host = localHostIdentity(), platform = process.platform } = {}) {
  const result = await lookupProcessIdentity(pid, host, { platform })
  if (result.status !== 'alive') throw new Error(`Identidade do processo indisponível: ${result.reason || result.status}`)
  return result.startIdentity
}

export async function lookupProcessIdentity(pid, host = localHostIdentity(), { platform = process.platform, execFileImpl = execFileAsync, readFileImpl = readFile, kill = process.kill } = {}) {
  if (!Number.isInteger(Number(pid)) || Number(pid) < 1) return { status: 'unknown', reason: 'pid inválido' }
  if (host !== localHostIdentity()) return { status: 'unknown', reason: 'host remoto ou identidade de máquina divergente' }
  const number = Number(pid)
  let stat
  try { kill(number, 0) }
  catch (error) {
    if (error.code === 'ESRCH') return { status: 'dead' }
    if (error.code === 'EPERM') return { status: 'unknown', reason: 'permissão insuficiente para inspecionar o processo' }
    return { status: 'unknown', reason: `kill(pid, 0) falhou: ${error.message}` }
  }
  try {
    const { stdout } = await execFileImpl('ps', ['-p', String(number), '-o', 'lstart='], {
      shell: false,
      env: { LC_ALL: 'C', PATH: process.env.PATH || '/usr/bin:/bin' },
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 16 * 1024,
    })
    const started = String(stdout).trim().replace(/\s+/g, ' ')
    if (!started) {
      try { kill(number, 0) }
      catch (error) { if (error.code === 'ESRCH') return { status: 'dead' }; return { status: 'unknown', reason: 'ps vazio e estado do processo ambíguo' } }
      return { status: 'unknown', reason: 'ps não retornou identidade de início' }
    }
    let linuxStart = ''
    if (platform === 'linux') {
      try {
        const [rawStat, bootId] = await Promise.all([
          readFileImpl(`/proc/${number}/stat`, 'utf8'),
          readFileImpl('/proc/sys/kernel/random/boot_id', 'utf8'),
        ])
        // comm pode conter espaços e parênteses; starttime é o campo 22 do stat.
        const close = rawStat.lastIndexOf(')')
        const fieldsAfterComm = close >= 0 ? rawStat.slice(close + 1).trim().split(/\s+/) : []
        const startTime = fieldsAfterComm[19]
        if (!startTime || !bootId.trim()) return { status: 'unknown', reason: 'stat/boot_id Linux incompleto' }
        linuxStart = `:${bootId.trim()}:${startTime}`
      } catch (error) {
        if (error.code === 'ENOENT') {
          try { kill(number, 0) }
          catch (gone) { if (gone.code === 'ESRCH') return { status: 'dead' } }
        }
        return { status: 'unknown', reason: `não foi possível ler identidade Linux: ${error.message}` }
      }
    } else if (platform !== 'darwin') {
      return { status: 'unknown', reason: `plataforma não suportada: ${platform}` }
    }
    // macOS ps lstart tem resolução de um segundo. Ambiguidades devem permanecer desconhecidas.
    return { status: 'alive', startIdentity: `${platform}:${number}:${started}${linuxStart}` }
  } catch (error) {
    try { kill(number, 0) }
    catch (gone) { if (gone.code === 'ESRCH') return { status: 'dead' }; return { status: 'unknown', reason: 'ps falhou e estado do processo é ambíguo' } }
    return { status: 'unknown', reason: `ps falhou: ${error.message}` }
  }
}
