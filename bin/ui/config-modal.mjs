// Modal de engrenagem: lê e grava ~/.claude/graph-eng/config.json via GET/PUT /api/config
// (bin/ui-server.mjs, contrato em .graph-runs/20260928-0213-fases-esforco-teto/D2.md §6). Também move
// para aqui o switch de tema, que sai do rodapé da lateral (index.html). Sem inner/outerHTML: todo texto
// vindo da API ou do usuário entra por textContent ou .value.
//
// Exporta initSettings(), chamado uma vez por app.js.

import { targetFor, targetTable, targetRange, validateCeiling } from './agent-target.mjs'

const $ = (id) => document.getElementById(id)

const EFFORT_LEVELS = ['low', 'medium', 'high', 'max']
const CLOSE_MS = 400 // reserva se `transitionend` não disparar (movimento reduzido, aba em segundo plano)

export function initSettings() {
  const dialog = $('settings')
  if (!dialog) return // painel antigo sem o markup do modal

  const form = $('settings-form')
  const openBtn = $('settings-open')
  const closeBtn = $('settings-close')
  const backdrop = dialog // ::backdrop não é um elemento acessível por id; o clique é detectado por event.target
  const status = $('settings-status')
  const resetBtn = $('settings-reset')
  const saveBtn = $('settings-save')

  const els = {
    ceiling: $('cfg-ceiling'),
    ceilingErr: $('cfg-ceiling-err'),
    effortHelp: $('cfg-effort-help'),
    preview: $('cfg-preview'),
    table: $('cfg-table'),
    economyHelp: $('cfg-economy-help'),
    planGate: $('cfg-plan-gate'),
    maxRounds: $('cfg-max-rounds'),
    maxRoundsErr: $('cfg-max-rounds-err'),
    maxRepairs: $('cfg-max-repairs'),
    maxRepairsErr: $('cfg-max-repairs-err'),
    themeSwitch: $('theme-switch'),
    themeLabel: $('theme-label'),
  }
  const effortRadios = [...form.querySelectorAll('input[name="effort"]')]
  const economyRadios = [...form.querySelectorAll('input[name="economy"]')]
  const fields = [els.ceiling, els.planGate, els.maxRounds, els.maxRepairs, ...effortRadios, ...economyRadios]

  let opener = null
  let defaults = null
  let loaded = false

  // ── Tema (movido do rodapé; não depende do GET/PUT) ──
  function syncThemeSwitch() {
    const dark = window.graphEngTheme ? window.graphEngTheme.get() === 'dark' : false
    els.themeSwitch.setAttribute('aria-checked', String(dark))
  }
  els.themeSwitch.addEventListener('click', () => {
    if (!window.graphEngTheme) return
    window.graphEngTheme.set(window.graphEngTheme.get() === 'dark' ? 'light' : 'dark')
    syncThemeSwitch()
  })
  new MutationObserver(syncThemeSwitch).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  syncThemeSwitch()

  // ── Preenchimento (sempre .value/.checked/aria-checked, nunca HTML bruto) ──
  function fill(config) {
    els.ceiling.value = String(config.ceiling)
    for (const r of effortRadios) r.checked = r.value === config.effort
    for (const r of economyRadios) r.checked = r.value === config.economy
    setSwitch(els.planGate, !!config.planGate)
    els.maxRounds.value = String(config.maxRounds)
    els.maxRepairs.value = String(config.maxRepairs)
    clearErrors()
    updatePreview()
  }

  function setSwitch(btn, on) {
    btn.setAttribute('aria-checked', String(on))
  }

  function setEnabled(enabled) {
    for (const f of fields) f.disabled = !enabled
    saveBtn.disabled = !enabled
    resetBtn.disabled = !enabled
  }

  function setStatus(text) {
    status.textContent = text || ''
  }

  function clearErrors() {
    for (const [input, err] of [[els.ceiling, els.ceilingErr], [els.maxRounds, els.maxRoundsErr], [els.maxRepairs, els.maxRepairsErr]]) {
      input.removeAttribute('aria-invalid')
      err.hidden = true
      err.textContent = ''
    }
  }

  function setFieldError(input, err, message) {
    input.setAttribute('aria-invalid', 'true')
    err.textContent = message
    err.hidden = false
  }

  // ── Prévia, recalculada a cada input/change (D2 §6.3) ──
  function currentEffort() {
    return (effortRadios.find((r) => r.checked) || {}).value || 'auto'
  }

  function updatePreview() {
    const raw = els.ceiling.value
    const ceiling = Number(raw)
    const level = currentEffort()
    const v = validateCeiling(raw)
    if (!v.ok) {
      setText(els.preview, '—')
    } else if (level === 'manual') {
      setText(els.preview, 'Você escolhe ao disparar')
    } else if (level === 'auto') {
      const r = targetRange(ceiling)
      setText(els.preview, `≈ ${r.min}–${r.max} agentes por run`)
    } else {
      setText(els.preview, `≈ ${targetFor(level, ceiling)} agentes por run`)
    }
    setText(
      els.effortHelp,
      level === 'manual'
        ? 'Manual: a cada disparo a skill pergunta o nível e mostra quantos agentes cada um usa. Sem humano para responder, vale o automático.'
        : level === 'auto'
          ? 'Automático: o Claude escolhe o nível pela complexidade da tarefa e diz por quê no plan gate.'
          : 'Tamanho fixo do grafo.',
    )
    if (v.ok) {
      const t = targetTable(ceiling)
      setText(els.table, `Baixo ${t.low} · Médio ${t.medium} · Alto ${t.high} · Máximo ${t.max}`)
    } else {
      setText(els.table, '')
    }
  }

  function setText(e, text) {
    if (e.textContent !== text) e.textContent = text
  }

  // ── Validação local, igual à do servidor ──
  function validate() {
    clearErrors()
    let ok = true
    let firstInvalid = null
    const c = validateCeiling(els.ceiling.value)
    if (!c.ok) {
      setFieldError(els.ceiling, els.ceilingErr, c.error)
      ok = false
      firstInvalid = firstInvalid || els.ceiling
    }
    const rounds = Number(els.maxRounds.value)
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) {
      setFieldError(els.maxRounds, els.maxRoundsErr, 'de 1 a 5')
      ok = false
      firstInvalid = firstInvalid || els.maxRounds
    }
    const repairs = Number(els.maxRepairs.value)
    if (!Number.isInteger(repairs) || repairs < 1 || repairs > 3) {
      setFieldError(els.maxRepairs, els.maxRepairsErr, 'de 1 a 3')
      ok = false
      firstInvalid = firstInvalid || els.maxRepairs
    }
    if (!ok && firstInvalid) firstInvalid.focus()
    return ok
  }

  function payload() {
    return {
      effort: currentEffort(),
      ceiling: Number(els.ceiling.value),
      economy: (economyRadios.find((r) => r.checked) || {}).value || 'balanced',
      planGate: els.planGate.getAttribute('aria-checked') === 'true',
      maxRounds: Number(els.maxRounds.value),
      maxRepairs: Number(els.maxRepairs.value),
    }
  }

  // ── Abrir / fechar (foco preso, Esc, animação) ──
  async function open() {
    opener = document.activeElement
    dialog.showModal()
    requestAnimationFrame(() => dialog.setAttribute('data-state', 'open'))
    els.ceiling.focus({ preventScroll: true })
    setStatus('')
    setEnabled(false)
    loaded = false
    try {
      const res = await fetch('/api/config')
      if (!res.ok) throw new Error('not ok')
      const body = await res.json()
      defaults = body.defaults
      els.ceiling.min = String(body.limits.ceiling.min)
      els.ceiling.max = String(body.limits.ceiling.max)
      fill(body.config)
      setEnabled(true)
      loaded = true
      // o campo estava desabilitado durante o GET e perdeu o foco; devolve para quem usa teclado
      if (dialog.open) els.ceiling.focus({ preventScroll: true })
    } catch {
      setStatus('Não consegui ler a config. Painel antigo? Reinicie o graph-watch ui.')
      closeBtn.focus({ preventScroll: true })
    }
  }

  function close() {
    if (dialog.getAttribute('data-state') === 'closed') return
    dialog.setAttribute('data-state', 'closing')
    let done = false
    const finish = () => {
      if (done) return
      done = true
      dialog.close()
      dialog.setAttribute('data-state', 'closed')
      const card = form
      card.removeEventListener('transitionend', onEnd)
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true })
      else openBtn.focus({ preventScroll: true })
    }
    const onEnd = (e) => {
      if (e.target === form && e.propertyName === 'transform') finish()
    }
    form.addEventListener('transitionend', onEnd)
    setTimeout(finish, CLOSE_MS)
  }

  openBtn.addEventListener('click', open)
  closeBtn.addEventListener('click', close)
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault() // não corta a animação de saída
    close()
  })
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close() // clique no backdrop
  })

  function focusable() {
    return [...dialog.querySelectorAll('button, input, [tabindex]')].filter((e) => !e.disabled && e.getClientRects().length > 0)
  }
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return
    const list = focusable()
    if (!list.length) return
    const first = list[0]
    const last = list[list.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  })

  for (const f of [els.ceiling, ...effortRadios]) {
    f.addEventListener('input', updatePreview)
    f.addEventListener('change', updatePreview)
  }
  els.ceiling.addEventListener('input', () => {
    els.ceiling.removeAttribute('aria-invalid')
    els.ceilingErr.hidden = true
  })

  for (const btn of [els.planGate]) {
    btn.addEventListener('click', () => setSwitch(btn, btn.getAttribute('aria-checked') !== 'true'))
  }

  resetBtn.addEventListener('click', () => {
    if (!defaults) return
    fill(defaults)
  })

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (!loaded || !validate()) return
    saveBtn.disabled = true
    setStatus('Salvando…')
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload()),
      })
      const body = await res.json().catch(() => ({}))
      if (res.ok) {
        setStatus('Salvo.')
        close()
      } else if (res.status === 400 && body.fields) {
        for (const [key, err] of [
          ['ceiling', els.ceilingErr],
          ['maxRounds', els.maxRoundsErr],
          ['maxRepairs', els.maxRepairsErr],
        ]) {
          if (body.fields[key]) {
            const input = key === 'ceiling' ? els.ceiling : key === 'maxRounds' ? els.maxRounds : els.maxRepairs
            setFieldError(input, err, body.fields[key])
          }
        }
        setStatus(body.error || 'config inválida')
      } else {
        setStatus(body.error || 'não consegui salvar')
      }
    } catch {
      setStatus('sem conexão com o painel')
    } finally {
      saveBtn.disabled = false
    }
  })
}
