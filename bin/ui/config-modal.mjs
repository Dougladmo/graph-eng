// Modal de configuração pública: effort e tema. Texto externo sempre entra por textContent/value.
const $ = (id) => document.getElementById(id)
const CLOSE_MS = 400

export function initSettings() {
  const dialog = $('settings')
  if (!dialog) return
  const form = $('settings-form')
  const openBtn = $('settings-open')
  const closeBtn = $('settings-close')
  const status = $('settings-status')
  const resetBtn = $('settings-reset')
  const saveBtn = $('settings-save')
  const themeSwitch = $('theme-switch')
  const radios = [...form.querySelectorAll('input[name="effort"]')]
  let opener = null
  let defaults = { effort: 'medium' }
  let loaded = false

  function syncTheme() {
    const dark = window.graphEngTheme?.get() === 'dark'
    themeSwitch.setAttribute('aria-checked', String(dark))
  }
  themeSwitch.addEventListener('click', () => {
    if (!window.graphEngTheme) return
    window.graphEngTheme.set(window.graphEngTheme.get() === 'dark' ? 'light' : 'dark')
    syncTheme()
  })
  new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  syncTheme()

  function fill(config = {}) {
    const effort = ['low', 'medium', 'max'].includes(config.effort) ? config.effort : 'medium'
    for (const radio of radios) radio.checked = radio.value === effort
  }
  function currentEffort() { return radios.find((radio) => radio.checked)?.value || 'medium' }
  function setEnabled(enabled) {
    for (const radio of radios) radio.disabled = !enabled
    saveBtn.disabled = !enabled
    resetBtn.disabled = !enabled
  }
  function focusEffort() { (radios.find((radio) => radio.checked && !radio.disabled) || radios.find((radio) => !radio.disabled))?.focus({ preventScroll: true }) }
  function close() {
    if (!dialog.open || dialog.dataset.state === 'closing') return
    dialog.dataset.state = 'closing'
    let done = false
    const finish = () => {
      if (done) return
      done = true
      dialog.close()
      dialog.dataset.state = 'closed'
      form.removeEventListener('transitionend', onEnd)
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true })
      else openBtn.focus({ preventScroll: true })
    }
    const onEnd = (event) => { if (event.target === form && event.propertyName === 'transform') finish() }
    form.addEventListener('transitionend', onEnd)
    setTimeout(finish, CLOSE_MS)
  }

  async function open() {
    opener = document.activeElement
    dialog.showModal()
    requestAnimationFrame(() => { dialog.dataset.state = 'open' })
    status.textContent = ''
    setEnabled(false)
    loaded = false
    focusEffort()
    try {
      const response = await fetch('/api/config')
      if (!response.ok) throw new Error('leitura recusada')
      const body = await response.json()
      defaults = body.defaults || { effort: 'medium' }
      fill(body.config)
      setEnabled(true)
      loaded = true
      if (dialog.open) focusEffort()
    } catch {
      status.textContent = 'Não consegui ler a config. Reinicie o graph-watch ui.'
      closeBtn.focus({ preventScroll: true })
    }
  }

  openBtn.addEventListener('click', open)
  closeBtn.addEventListener('click', close)
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close() })
  dialog.addEventListener('click', (event) => { if (event.target === dialog) close() })
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return
    const focusable = [...dialog.querySelectorAll('button, input, [tabindex]')].filter((el) => !el.disabled && el.getClientRects().length)
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  })
  resetBtn.addEventListener('click', () => fill(defaults))
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!loaded) return
    saveBtn.disabled = true
    status.textContent = 'Salvando…'
    try {
      const response = await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ effort: currentEffort() }) })
      const body = await response.json().catch(() => ({}))
      if (response.ok) { status.textContent = 'Salvo.'; close() }
      else status.textContent = body.error || (body.fields ? `Configuração inválida: ${Object.values(body.fields).join(', ')}` : 'Não consegui salvar.')
    } catch { status.textContent = 'Sem conexão com o painel.' }
    finally { saveBtn.disabled = false }
  })
}
