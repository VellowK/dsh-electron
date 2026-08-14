/**
 * Plugin manager window preload — exposes `dshPlugins` over the context bridge.
 */

import { contextBridge, ipcRenderer } from 'electron'

export interface InstalledPlugin {
  name: string
  version: string
  isBundle: boolean
}

export interface SearchResult {
  name: string
  version: string
  description: string
}

export interface CommandResult {
  code: number
  output: string
  restarted?: string
}

contextBridge.exposeInMainWorld('dshPlugins', {
  list: (): Promise<{ installed: InstalledPlugin[]; bundles: string[] }> =>
    ipcRenderer.invoke('plugins:list'),
  search: (query: string): Promise<SearchResult[]> =>
    ipcRenderer.invoke('plugins:search', query),
  install: (pkg: string): Promise<CommandResult> =>
    ipcRenderer.invoke('plugins:install', pkg),
  uninstall: (pkg: string): Promise<CommandResult> =>
    ipcRenderer.invoke('plugins:uninstall', pkg),
  update: (pkg: string): Promise<CommandResult> =>
    ipcRenderer.invoke('plugins:update', pkg),
})
