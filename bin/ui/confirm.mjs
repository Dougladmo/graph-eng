// Dialog genérico de confirmação: Apagar run, Apagar finalizadas e Apagar grupo (bin/ui/app.js, I6). O I7
// reaproveita o mesmo `<dialog id="confirm">` para Parar… e Refazer nó…. Mesmo padrão de
// config-modal.mjs (data-state, animação, Esc, backdrop, foco preso, foco de volta a quem abriu). Sem
// inner/outerHTML: todo texto entra por textContent ou nós criados com createElement.
// Contrato: docs/specs/2026-09-28-acoes-no-painel.md C13.

const $ = (id) => document.getElementById(id)
const CLOSE_MS = 400

let dialog, form, titleEl, closeBtn, bodyEl, extraEl, typedLabel, typedInput, fieldErr, cancelBtn, okBtn
let inited = false
let opener = null
let current = null // { typed, check, onConfirm }

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function focusable() {
  return [...dialog.querySelectorAll('button, input, [tabindex]')].filter((e) => !e.disabled && e.getClientRects().length > 0)
}

function setFieldErr(msg) {
  fieldErr.textContent = msg || ''
  fieldErr.hidden = !msg
}

function syncOkEnabled() {
  if (!current || !current.typed) {
    okBtn.disabled = false
    return
  }
  const check = current.check || ((v) => v === current.typed)
  okBtn.disabled = !check(typedInput.value)
}

function close() {
  if (!dialog || dialog.getAttribute('data-state') === 'closed') return
  dialog.setAttribute('data-state', 'closing')
  let done = false
  const finish = () => {
    if (done) return
    done = true
    dialog.close()
    dialog.setAttribute('data-state', 'closed')
    form.removeEventListener('transitionend', onEnd)
    current = null
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true })
  }
  const onEnd = (e) => {
    if (e.target === form && e.propertyName === 'transform') finish()
  }
  form.addEventListener('transitionend', onEnd)
  setTimeout(finish, CLOSE_MS)
}

async function onSubmit(e) {
  e.preventDefault()
  if (!current || okBtn.disabled) return
  okBtn.setAttribute('aria-busy', 'true')
  const prevDisabled = okBtn.disabled
  okBtn.disabled = true
  try {
    const res = await current.onConfirm(typedInput.hidden ? undefined : typedInput.value)
    if (res && res.error) setFieldErr(res.error)
    else close()
  } finally {
    okBtn.removeAttribute('aria-busy')
    okBtn.disabled = prevDisabled
    syncOkEnabled()
  }
}

function ensure() {
  if (inited) return dialog != null
  inited = true
  dialog = $('confirm')
  if (!dialog) return false
  form = $('confirm-form')
  titleEl = $('confirm-title')
  closeBtn = $('confirm-close')
  bodyEl = $('confirm-body-text')
  extraEl = $('confirm-extra')
  typedLabel = $('confirm-typed-label')
  typedInput = $('confirm-typed')
  fieldErr = $('confirm-field-err')
  cancelBtn = $('confirm-cancel')
  okBtn = $('confirm-ok')
  closeBtn.addEventListener('click', close)
  cancelBtn.addEventListener('click', close)
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault() // não corta a animação de saída
    close()
  })
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close() // clique no backdrop
  })
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
  typedInput.addEventListener('input', syncOkEnabled)
  form.addEventListener('submit', onSubmit)
  return true
}

// openConfirm({ title, body, typed?, check?, confirmText, danger, focus, onConfirm }) (C13). `body`: string
// (vira textContent) ou um nó DOM já pronto (ex.: a lista rolável de "Apagar finalizadas"). `typed`: texto
// que precisa bater para habilitar o botão (checado por `check`, padrão `v === typed`). `onConfirm(typedValue)`
// devolve `{ error, fields }` para mostrar sem fechar, ou nada/`{}` para fechar. `focus`: 'typed' | 'ok' |
// undefined (Cancelar, o padrão sem campo digitado).
export function openConfirm({ title, body, typed = null, check = null, confirmText = 'Confirmar', danger = false, focus = null, onConfirm }) {
  if (!ensure()) return
  opener = document.activeElement
  current = { typed, check, onConfirm }
  titleEl.textContent = title || ''
  bodyEl.textContent = ''
  extraEl.replaceChildren()
  extraEl.hidden = true
  if (typeof body === 'string') {
    bodyEl.textContent = body
  } else if (body) {
    extraEl.hidden = false
    extraEl.append(body)
  }
  setFieldErr('')
  okBtn.textContent = confirmText
  okBtn.classList.toggle('btn-danger', !!danger)
  okBtn.removeAttribute('aria-busy')
  if (typed) {
    typedLabel.hidden = false
    typedLabel.replaceChildren('Digite ', el('strong', null, typed), ' para confirmar')
    typedInput.hidden = false
    typedInput.value = ''
  } else {
    typedLabel.hidden = true
    typedInput.hidden = true
  }
  syncOkEnabled()
  dialog.showModal()
  requestAnimationFrame(() => dialog.setAttribute('data-state', 'open'))
  const toFocus = focus === 'typed' && typed ? typedInput : focus === 'ok' ? okBtn : cancelBtn
  toFocus.focus({ preventScroll: true })
}

export function closeConfirm() {
  close()
}
