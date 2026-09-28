// Preferências de quem olha o painel, aplicadas no <head> antes do CSS pintar (sem piscar):
// tema claro/escuro em <html data-theme> (salvo, ou o do sistema) e a lateral de runs aberta ou
// recolhida em <html data-rail>. O app.js liga o switch de tema e os botões da lateral a
// window.graphEngTheme e window.graphEngRail.
;(function () {
  var root = document.documentElement
  var media = window.matchMedia('(prefers-color-scheme: dark)')

  function read(key, allowed) {
    try {
      var v = localStorage.getItem(key)
      return allowed.indexOf(v) >= 0 ? v : null
    } catch (e) {
      return null
    }
  }
  function write(key, value) {
    try {
      localStorage.setItem(key, value)
    } catch (e) {
      /* navegação privada: vale só para esta aba */
    }
  }

  // ── tema ──
  var THEME = 'graph-eng-theme'
  function applyTheme(theme) {
    root.dataset.theme = theme
    root.style.colorScheme = theme
  }
  applyTheme(read(THEME, ['dark', 'light']) || (media.matches ? 'dark' : 'light'))
  // sem escolha salva, acompanha o sistema
  media.addEventListener('change', function (e) {
    if (!read(THEME, ['dark', 'light'])) applyTheme(e.matches ? 'dark' : 'light')
  })
  window.graphEngTheme = {
    get: function () {
      return root.dataset.theme
    },
    set: function (theme) {
      applyTheme(theme)
      write(THEME, theme)
    },
  }

  // ── lateral de runs ──
  var RAIL = 'graph-eng-rail'
  root.dataset.rail = read(RAIL, ['open', 'closed']) || 'open'
  window.graphEngRail = {
    get: function () {
      return root.dataset.rail
    },
    set: function (state) {
      root.dataset.rail = state
      write(RAIL, state)
    },
  }
})()
