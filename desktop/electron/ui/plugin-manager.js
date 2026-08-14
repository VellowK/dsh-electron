/* Plugin manager UI — vanilla JS, no build step. Talks to `window.dshPlugins`. */
/* global dshPlugins */

'use strict'

const api = window.dshPlugins
const listEl = document.getElementById('installed-list')
const resultsEl = document.getElementById('search-results')
const logEl = document.getElementById('log-output')
const inputEl = document.getElementById('search-input')

function log(message) {
  logEl.textContent += `${message}\n`
  logEl.scrollTop = logEl.scrollHeight
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

function pluginItem(plugin, opts) {
  const item = el('li', 'plugin-item')

  const meta = el('div', 'meta')
  meta.appendChild(el('div', 'name', plugin.name))
  if (plugin.description) meta.appendChild(el('div', 'desc', plugin.description))

  const version = el('span', 'version', plugin.version ? `v${plugin.version}` : '')

  const actions = el('div', 'actions')

  if (opts.kind === 'installed') {
    if (plugin.isBundle) {
      item.appendChild(el('span', 'badge bundle', 'bundle'))
    }
    const updateBtn = el('button', '', '更新')
    updateBtn.addEventListener('click', () => runCommand('update', plugin.name, '更新', updateBtn))
    const removeBtn = el('button', 'danger', '卸载')
    removeBtn.addEventListener('click', () => {
      if (!confirm(`确定卸载 ${plugin.name} 吗？`)) return
      runCommand('uninstall', plugin.name, '卸载', removeBtn)
    })
    actions.appendChild(updateBtn)
    actions.appendChild(removeBtn)
  } else {
    const installBtn = el('button', 'primary', '安装')
    installBtn.addEventListener('click', () => runCommand('install', plugin.name, '安装', installBtn))
    actions.appendChild(installBtn)
  }

  item.appendChild(meta)
  item.appendChild(version)
  item.appendChild(actions)
  return item
}

async function refreshInstalled() {
  clear(listEl)
  try {
    const { installed } = await api.list()
    if (installed.length === 0) {
      listEl.appendChild(el('li', 'empty', '尚未安装任何插件'))
      return
    }
    for (const plugin of installed) listEl.appendChild(pluginItem(plugin, { kind: 'installed' }))
  } catch (error) {
    listEl.appendChild(el('li', 'empty', `加载失败：${error.message ?? error}`))
  }
}

async function search() {
  const query = inputEl.value
  clear(resultsEl)
  resultsEl.hidden = false
  resultsEl.appendChild(el('div', 'empty', '搜索中…'))
  try {
    const results = await api.search(query)
    clear(resultsEl)
    if (results.length === 0) {
      resultsEl.appendChild(el('div', 'empty', '无结果'))
      return
    }
    const list = el('ul', 'plugin-list')
    for (const plugin of results) list.appendChild(pluginItem(plugin, { kind: 'search' }))
    resultsEl.appendChild(list)
  } catch (error) {
    clear(resultsEl)
    resultsEl.appendChild(el('div', 'empty', `搜索失败：${error.message ?? error}`))
  }
}

async function runCommand(kind, pkg, label, button) {
  button.disabled = true
  log(`\n>> ${label} ${pkg} …`)
  try {
    const result = await api[kind](pkg)
    log(result.output.trim() || '(无输出)')
    if (result.code === 0) {
      log(`✓ ${label} ${pkg} 完成${result.restarted ? '，harness 已重启' : ''}`)
      await refreshInstalled()
    } else {
      log(`✗ ${label} ${pkg} 失败（退出码 ${result.code}）`)
    }
  } catch (error) {
    log(`✗ ${label} ${pkg} 出错：${error.message ?? error}`)
  } finally {
    button.disabled = false
  }
}

document.getElementById('search-btn').addEventListener('click', search)
inputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') search()
})
document.getElementById('refresh-btn').addEventListener('click', refreshInstalled)

refreshInstalled()
