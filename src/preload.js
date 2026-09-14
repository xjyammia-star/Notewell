const { contextBridge, ipcRenderer } = require('electron')

// preload 层监听 drop，用文件元信息让 main 处理路径
window.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('dragover', (e) => e.preventDefault(), true)
  document.addEventListener('drop', (e) => {
    e.preventDefault()
    if (!e.dataTransfer || !e.dataTransfer.files.length) return
    const fileInfos = Array.from(e.dataTransfer.files).map(f => ({ name: f.name, size: f.size, lastModified: f.lastModified }))
    ipcRenderer.invoke('resolve-dropped-files', fileInfos).then(paths => {
      if (paths && paths.length) {
        ipcRenderer.send('renderer-files-dropped', paths)
      }
    })
  }, true)

  ipcRenderer.on('files-dropped-reply', (_e, paths) => {
    if (window.__onFilesDropped) window.__onFilesDropped(paths)
  })
})

contextBridge.exposeInMainWorld('api', {
  selectVault:       ()          => ipcRenderer.invoke('select-vault'),
  getVaultPath:      ()          => ipcRenderer.invoke('get-vault-path'),
  getVaultStats:     (vaultPath) => ipcRenderer.invoke('get-vault-stats', vaultPath),
  searchFiles:       (args)      => ipcRenderer.invoke('search-files', args),
  openFile:          (filePath)  => ipcRenderer.invoke('open-file', filePath),
  openFileDirectly:  (filePath)  => ipcRenderer.invoke('open-file-directly', filePath),
  openExternalUrl:   (url)       => ipcRenderer.invoke('open-external-url', url),
  processFeedCaption:(args)      => ipcRenderer.invoke('process-feed-caption', args),
  openInObsidian:    (filePath)  => ipcRenderer.invoke('open-in-obsidian', filePath),
  importFiles:       (args)      => ipcRenderer.invoke('import-files', args),
  selectImportFiles: ()          => ipcRenderer.invoke('select-import-files'),
  getVaultFolders:   (vaultPath) => ipcRenderer.invoke('get-vault-folders', vaultPath),
  listFolderFiles:   (args)      => ipcRenderer.invoke('list-folder-files', args),
  listFilesByType:   (args)      => ipcRenderer.invoke('list-files-by-type', args),
  selectInbox:       ()          => ipcRenderer.invoke('select-inbox'),
  getInboxPath:      ()          => ipcRenderer.invoke('get-inbox-path'),
  listInboxFiles:    (inboxPath) => ipcRenderer.invoke('list-inbox-files', inboxPath),
  checkDuplicates:   (vaultPath) => ipcRenderer.invoke('check-duplicate-files', vaultPath),
  checkEmptyFiles:   (vaultPath) => ipcRenderer.invoke('check-empty-files', vaultPath),
  deleteFile:        (filePath)  => ipcRenderer.invoke('delete-file', filePath),
  moveFile:          (args)      => ipcRenderer.invoke('move-file', args),
  hubBatchUpdate:    (vaultPath) => ipcRenderer.invoke('hub-batch-update', vaultPath),
  hubScan:           (vaultPath) => ipcRenderer.invoke('hub-scan', vaultPath),
  hubUpdateSelected: (args)      => ipcRenderer.invoke('hub-update-selected', args),
  hubUpdateFolder:   (args)      => ipcRenderer.invoke('hub-update-folder', args),
  scanMissingSummary:(args)      => ipcRenderer.invoke('scan-missing-summary', args),
  writeSummary:      (args)      => ipcRenderer.invoke('write-summary', args),
  feedGetAll:        ()          => ipcRenderer.invoke('feed-get-all'),
  feedMarkPlatformLoggedIn: (platform) => ipcRenderer.invoke('feed-mark-platform-logged-in', platform),
  feedAdd:           (args)      => ipcRenderer.invoke('feed-add', args),
  feedDelete:        (index)     => ipcRenderer.invoke('feed-delete', index),
  feedOpenLogin:     (index)     => ipcRenderer.invoke('feed-open-login', index),
  feedCheckLogin:    (index)     => ipcRenderer.invoke('feed-check-login', index),
  onFeedLoginSuccess:(cb)        => ipcRenderer.on('feed-login-success', (_e, index) => cb(index)),
  feedCheckOne:      (index)     => ipcRenderer.invoke('feed-check-one', index),
  feedResetOne:      (index)     => ipcRenderer.invoke('feed-reset-one', index),
  feedRename:        (args)      => ipcRenderer.invoke('feed-rename', args),
  feedCheckAll:      ()          => ipcRenderer.invoke('feed-check-all'),
  getTagStats:       (vaultPath) => ipcRenderer.invoke('get-tag-stats', vaultPath),
  searchByTag:       (args)      => ipcRenderer.invoke('search-by-tag', args),
  createNote:        (args)      => ipcRenderer.invoke('create-note', args),
  moveNote:          (args)      => ipcRenderer.invoke('move-note', args),
  saveAiSettings:    (settings)  => ipcRenderer.invoke('save-ai-settings', settings),
  getAiSettings:     ()          => ipcRenderer.invoke('get-ai-settings'),
  testRelayConnection: (kind)    => ipcRenderer.invoke('test-relay-connection', { kind }),
  focusWindow:       ()          => ipcRenderer.invoke('focus-window'),
  selectInboxFolder: ()          => ipcRenderer.invoke('select-inbox-folder'),
  aiClassifyFile:    (args)      => ipcRenderer.invoke('ai-classify-file', args),
  aiImportFiles:     (args)      => ipcRenderer.invoke('ai-import-files', args),
  getProcessedFolder:(inboxPath) => ipcRenderer.invoke('get-processed-folder', inboxPath),
  clearProcessedFolder:(inboxPath)=> ipcRenderer.invoke('clear-processed-folder', inboxPath),
  aiAnalyzeFolder:   (args)      => ipcRenderer.invoke('ai-analyze-folder', args),
  onAnalyzeProgress: (cb)        => ipcRenderer.on('ai-analyze-progress', (_e, data) => cb(data)),
  offAnalyzeProgress:()          => ipcRenderer.removeAllListeners('ai-analyze-progress'),
  getFolderTree:     (vaultPath) => ipcRenderer.invoke('get-folder-tree', vaultPath),
  getFolderMdFiles:  (folderPath)=> ipcRenderer.invoke('get-folder-md-files', folderPath),
  createFolder:      (args)      => ipcRenderer.invoke('create-folder', args),
  deleteFolder:      (args)      => ipcRenderer.invoke('delete-folder', args),
  selectAudioFile:   ()          => ipcRenderer.invoke('select-audio-file'),
  aiAudioToNote:     (args)      => ipcRenderer.invoke('ai-audio-to-note', args),
  onAudioNoteProgress:(cb)       => ipcRenderer.on('audio-note-progress', (_e, data) => cb(data)),
  offAudioNoteProgress:()        => ipcRenderer.removeAllListeners('audio-note-progress'),
  onFilesDropped:    (cb)        => { window.__onFilesDropped = cb },
  youtubeToNote:     (args)      => ipcRenderer.invoke('youtube-to-note', args),
  onYoutubeProgress: (cb)        => ipcRenderer.on('youtube-note-progress', (_e, msg) => cb(msg)),
  offYoutubeProgress:()          => ipcRenderer.removeAllListeners('youtube-note-progress'),
  selectCookiesFile: ()          => ipcRenderer.invoke('select-cookies-file'),
  webpageToNote:     (args)      => ipcRenderer.invoke('webpage-to-note', args),
  onWebpageProgress: (cb)        => ipcRenderer.on('webpage-note-progress', (_e, msg) => cb(msg)),
  offWebpageProgress:()          => ipcRenderer.removeAllListeners('webpage-note-progress'),
  aiSmartSaveNote:   (args)      => ipcRenderer.invoke('ai-smart-save-note', args),
  pdfSmartSave:      (args)      => ipcRenderer.invoke('pdf-smart-save', args),
  getAppVersion:     ()          => ipcRenderer.invoke('get-app-version'),
  getTokenStats:     ()          => ipcRenderer.invoke('get-token-stats'),
  onUpdateDownloading:(cb)       => ipcRenderer.on('update-downloading', (_e) => cb()),
  onUpdateProgress:  (cb)        => ipcRenderer.on('update-progress', (_e, percent) => cb(percent)),
  onUpdateError:     (cb)        => ipcRenderer.on('update-error', (_e) => cb()),
  onUpdateBrowserDownload: (cb) => ipcRenderer.on('update-browser-download', (_e) => cb()),
  onUpdateAvailableMac:  (cb)  => ipcRenderer.on('update-available-mac', (_e, ver) => cb(ver)),
  onFeedDebug:           (cb)  => ipcRenderer.on('feed-debug', (_e, data) => cb(data)),
  // ── 学习助手 ──
  studyInvoke:         (channel, args) => ipcRenderer.invoke(channel, args),
  readFileContent:     (filePath)      => ipcRenderer.invoke('read-file-content', filePath),
  // ── 激活码 ──
  licenseActivate:     (code)          => ipcRenderer.invoke('license-activate', { code }),
  licenseGetStatus:    ()              => ipcRenderer.invoke('license-get-status'),
  licenseDeactivate:   ()              => ipcRenderer.invoke('license-deactivate'),
  getAccessStatus:     ()              => ipcRenderer.invoke('get-access-status'),
  submitFeedback:      (content, contact) => ipcRenderer.invoke('submit-feedback', { content, contact }),
})
