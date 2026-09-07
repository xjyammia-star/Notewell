const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron')
const path = require('path')
const fs = require('fs')
const https = require('https')
const { pathToFileURL } = require('url')
const Store = require('electron-store')
const { autoUpdater } = require('electron-updater')
if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class DOMMatrix { constructor() {} }
}
const pdfParse = require('pdf-parse')

const store = new Store()
let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 720, minWidth: 800, minHeight: 600,
    title: 'Notewell',
    icon: path.join(__dirname, '../assets/icon.icns'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    acceptFirstMouse: true
  })
  mainWindow.loadFile(path.join(__dirname, 'index.html'))

  // 主进程监听渲染进程的 drop 事件，获取文件路径
}

// ── 自动更新配置 ──
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false

autoUpdater.on('update-available', (info) => {
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'info',
    title: '发现新版本',
    message: `发现新版本 v${info.version}`,
    detail: '是否现在下载更新？下载完成后会提示重启安装。',
    buttons: ['立即更新', '稍后再说'],
    defaultId: 0,
    cancelId: 1
  })
  if (choice === 0) {
    autoUpdater.downloadUpdate()
    mainWindow.webContents.send('update-downloading')
  }
})
autoUpdater.on('update-not-available', () => {})
autoUpdater.on('error', (err) => {
  const errMsg = err ? (err.stack || err.message || JSON.stringify(err)) : '未知错误'
  try {
    mainWindow.webContents.send('update-error')
    dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      title: '更新失败',
      message: '自动更新下载失败',
      detail: `${errMsg}\n\n请前往 GitHub 手动下载：\nhttps://github.com/xjyammia-star/Obsidian-/releases/latest`,
      buttons: ['确定']
    })
  } catch(_) {}
})
autoUpdater.on('download-progress', (progress) => {
  mainWindow.webContents.send('update-progress', Math.floor(progress.percent))
})
autoUpdater.on('update-downloaded', () => {
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'info',
    title: '更新已就绪',
    message: '新版本已下载完成',
    detail: '点击「立即重启」完成安装，或稍后手动重启。',
    buttons: ['立即重启', '稍后重启'],
    defaultId: 0,
    cancelId: 1
  })
  if (choice === 0) autoUpdater.quitAndInstall(true, true)
})

app.whenReady().then(() => {
  createWindow()
  if (process.platform === 'darwin') {
    try {
      const { nativeImage } = require('electron')
      const icnsPath = path.join(__dirname, '../assets/icon.icns')
      if (fs.existsSync(icnsPath)) {
        const image = nativeImage.createFromPath(icnsPath)
        if (!image.isEmpty()) app.dock.setIcon(image)
      }
    } catch (e) { console.log('dock icon error:', e.message) }
  }
  // Mac 无代码签名，用轻量版本检查（只提示，不自动下载）
  // Windows 用 electron-updater 完整自动更新
  if (process.platform === 'darwin') {
    setTimeout(() => {
      try {
        https.get({
          hostname: 'api.github.com',
          path: '/repos/xjyammia-star/Obsidian-/releases/latest',
          headers: { 'User-Agent': 'obsidian-manager', 'Accept': 'application/vnd.github.v3+json' }
        }, (res) => {
          let data = ''
          res.on('data', chunk => data += chunk)
          res.on('end', () => {
            try {
              const release = JSON.parse(data)
              const latest = (release.tag_name || '').replace(/^v/, '')
              const current = app.getVersion()
              if (latest && latest !== current) {
                const la = latest.split('.').map(Number)
                const cu = current.split('.').map(Number)
                let isNewer = false
                for (let i = 0; i < 3; i++) {
                  if ((la[i]||0) > (cu[i]||0)) { isNewer = true; break }
                  if ((la[i]||0) < (cu[i]||0)) break
                }
                if (isNewer) mainWindow.webContents.send('update-available-mac', latest)
              }
            } catch(_) {}
          })
        }).on('error', () => {})
      } catch(_) {}
    }, 3000)
  } else {
    setTimeout(() => {
      try { autoUpdater.checkForUpdates() } catch (_) {}
    }, 3000)
  }
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })

// ── 版本号 ──
ipcMain.handle('get-app-version', () => app.getVersion())

// ── 选择知识库 ──
ipcMain.handle('select-vault', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'], title: '选择你的 Obsidian 知识库文件夹'
  })
  if (!result.canceled && result.filePaths.length > 0) {
    store.set('vaultPath', result.filePaths[0])
    return { success: true, path: result.filePaths[0] }
  }
  return { success: false }
})

// ── 获取知识库路径 ──
ipcMain.handle('get-vault-path', () => store.get('vaultPath', null))

// ── 知识库统计 ──
ipcMain.handle('get-vault-stats', async (event, vaultPath) => {
  console.log('[IPC] get-vault-stats called at', Date.now())
  try { return { success: true, stats: scanDirectory(vaultPath) } }
  catch (err) { return { success: false, error: err.message } }
})

// ── 搜索文件（支持多条件）──
ipcMain.handle('search-files', async (event, { vaultPath, query, fileTypes, dateFrom, dateTo, sortBy }) => {
  try {
    // 文件类型扩展名映射
    const typeExtMap = {
      md:    ['.md'],
      pdf:   ['.pdf'],
      image: ['.png','.jpg','.jpeg','.gif','.webp'],
      video: ['.mp4','.mov','.avi','.mkv','.webm','.m4v'],
      other: null
    }
    const knownExts = ['.md','.pdf','.png','.jpg','.jpeg','.gif','.webp','.mp4','.mov','.avi','.mkv','.webm','.m4v']

    // 确定要扫描的文件类型
    const hasTypeFilter = fileTypes && fileTypes.length > 0 && !fileTypes.includes('all')
    let allowedExts = null
    if (hasTypeFilter) {
      allowedExts = new Set()
      for (const t of fileTypes) {
        if (t === 'other') { allowedExts = null; break } // other 需要特殊处理
        if (typeExtMap[t]) typeExtMap[t].forEach(e => allowedExts.add(e))
      }
    }
    const includeOther = hasTypeFilter && fileTypes.includes('other')

    // 日期范围
    const from = dateFrom ? new Date(dateFrom + 'T00:00:00') : null
    const to   = dateTo   ? new Date(dateTo   + 'T23:59:59') : null

    const q = query ? query.toLowerCase().trim() : ''
    const results = []

    // 扫描所有文件（不限 .md）
    const allFiles = getAllFiles(vaultPath)
    for (const filePath of allFiles) {
      const ext = path.extname(filePath).toLowerCase()
      const fileName = path.basename(filePath)
      const baseName = path.basename(filePath, ext)
      const stat = fs.statSync(filePath)
      const mtime = stat.mtime

      // 文件类型过滤
      if (hasTypeFilter) {
        const isKnown = knownExts.includes(ext)
        if (includeOther && fileTypes.length === 1) {
          if (isKnown) continue // 只看other
        } else if (allowedExts && !allowedExts.has(ext)) {
          if (!includeOther || isKnown) continue
        }
      }

      // 日期过滤
      if (from && mtime < from) continue
      if (to   && mtime > to)   continue

      // 关键词过滤
      let matched = !q
      let snippet = ''
      if (q) {
        if (fileName.toLowerCase().includes(q)) {
          matched = true; snippet = '文件名匹配'
        }
        if (!matched && ext === '.md') {
          try {
            const content = fs.readFileSync(filePath, 'utf-8')
            const idx = content.toLowerCase().indexOf(q)
            if (idx !== -1) {
              matched = true
              const start = Math.max(0, idx - 40)
              const end   = Math.min(content.length, idx + 80)
              snippet = '...' + content.slice(start, end).replace(/\n/g, ' ') + '...'
            }
          } catch (_) {}
        }
      }

      if (matched) {
        results.push({
          name: baseName,
          fullName: fileName,
          path: filePath,
          relativePath: path.relative(vaultPath, filePath),
          ext,
          mtime: mtime.toISOString().slice(0, 10),
          mtimeRaw: mtime.getTime(),
          snippet
        })
      }
    }

    // 排序
    if (sortBy === 'mtime_desc') results.sort((a, b) => b.mtimeRaw - a.mtimeRaw)
    else if (sortBy === 'mtime_asc') results.sort((a, b) => a.mtimeRaw - b.mtimeRaw)
    else if (sortBy === 'name_asc')  results.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    else if (sortBy === 'name_desc') results.sort((a, b) => b.name.localeCompare(a.name, 'zh'))
    // 默认：关键词相关度（文件名匹配优先）
    else if (q) results.sort((a, b) => {
      const aName = a.name.toLowerCase().includes(q) ? 0 : 1
      const bName = b.name.toLowerCase().includes(q) ? 0 : 1
      return aName - bName
    })

    return { success: true, results: results.slice(0, 200), total: results.length }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 在文件管理器中显示 ──
ipcMain.handle('open-file', async (event, filePath) => { shell.showItemInFolder(filePath) })
ipcMain.handle('open-file-directly', async (event, filePath) => { shell.openPath(filePath) })

// ── 在 Obsidian 中打开 ──
ipcMain.handle('open-in-obsidian', async (event, filePath) => {
  shell.openExternal('obsidian://open?path=' + encodeURIComponent(filePath))
  return { success: true }
})

// ── 导入文件 ──
ipcMain.handle('import-files', async (event, { files, targetDir }) => {
  const results = []
  for (const src of files) {
    try {
      const fileName = path.basename(src)
      fs.copyFileSync(src, path.join(targetDir, fileName))
      const mdName = fileName.replace(/\.[^.]+$/, '') + '.md'
      const mdPath = path.join(targetDir, mdName)
      const ext = path.extname(src).replace('.', '').toUpperCase()
      const now = new Date().toISOString().slice(0, 10)
      const mdContent = `---\ntitle: ${fileName}\ndate: ${now}\ntype: ${ext}\nsource: 导入\n---\n\n# ${fileName}\n\n- 导入日期：${now}\n- 文件类型：${ext}\n- 原始文件：[[${fileName}]]\n`
      if (!fs.existsSync(mdPath)) fs.writeFileSync(mdPath, mdContent, 'utf-8')
      // 移到已处理文件夹
      const inboxDir = path.dirname(src)
      const processedDir = path.join(inboxDir, '已处理')
      if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir)
      const processedPath = path.join(processedDir, fileName)
      try {
        if (fs.existsSync(processedPath)) {
          const ts = Date.now(), ext2 = path.extname(fileName), base = path.basename(fileName, ext2)
          fs.renameSync(src, path.join(processedDir, `${base}_${ts}${ext2}`))
        } else {
          fs.renameSync(src, processedPath)
        }
      } catch (_) {}
      results.push({ file: fileName, success: true })
    } catch (err) { results.push({ file: path.basename(src), success: false, error: err.message }) }
  }
  return results
})

// ── 选择要导入的文件 ──
ipcMain.handle('select-import-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'], title: '选择要导入的文件' })
  return result.canceled ? [] : result.filePaths
})

// ── 知识库文件夹列表 ──
ipcMain.handle('get-vault-folders', async (event, vaultPath) => {
  try { return { success: true, folders: getFolders(vaultPath, vaultPath) } }
  catch (err) { return { success: false, error: err.message } }
})


// -- get-folder-tree: folder tree with depth for AI analysis --
ipcMain.handle('get-folder-tree', async (event, vaultPath) => {
  try { return { success: true, tree: buildAnalyzeTree(vaultPath, vaultPath, 0) } }
  catch (err) { return { success: false, error: err.message } }
})

// -- get-folder-md-files: md files in a folder (non-recursive) --
ipcMain.handle('get-folder-md-files', async (event, folderPath) => {
  try {
    const files = []
    for (const item of fs.readdirSync(folderPath)) {
      if (item.startsWith('.')) continue
      const full = path.join(folderPath, item)
      const stat = fs.lstatSync(full)
      const ext = path.extname(item).toLowerCase()
      if (!stat.isDirectory() && (ext === '.md' || ext === '.pdf')) {
        files.push({ name: item, path: full, mtime: stat.mtime.toISOString().slice(0,10), type: ext.slice(1) })
      }
      // 显示 iCloud 占位符中的 .md 文件（未下载）
      if (item.endsWith('.icloud') && item.includes('.md')) {
        const realName = item.replace(/^\./, '').replace(/\.icloud$/, '')
        files.push({ name: realName, path: full, mtime: '', cloud: true, type: 'md' })
      }
    }
    return { success: true, files }
  } catch (err) { return { success: false, error: err.message } }
})
// ── 获取平台信息 ──
ipcMain.handle('get-platform', () => process.platform)

// -- drop 中转：preload 发来文件路径，主进程原样发回渲染进程 --
ipcMain.on('renderer-files-dropped', (event, paths) => {
  event.sender.send('files-dropped-reply', paths)
})

// -- resolve-dropped-files: 用文件元信息在磁盘上搜索完整路径 --
ipcMain.handle('resolve-dropped-files', async (event, fileInfos) => {
  // webUtils 在 preload 环境不可用，改为在常用目录里搜索同名文件
  const os = require('os')
  const home = os.homedir()
  const vaultPath = store.get('vaultPath', null)
  const inboxPath = store.get('inboxPath', null)
  // 不搜索 vaultPath（可能在 iCloud），只搜索本地常用目录
  const searchDirs = [
    inboxPath,
    path.join(home, 'Desktop'),
    path.join(home, 'Downloads'),
    path.join(home, 'Documents'),
  ].filter(Boolean)
  const results = []
  for (const info of fileInfos) {
    let found = null
    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue
      try {
        const walk = (d, depth) => {
          if (depth > 3) return
          for (const item of fs.readdirSync(d)) {
            if (item.startsWith('.')) continue
            const full = path.join(d, item)
            try {
              const stat = fs.statSync(full)
              if (stat.isDirectory()) { walk(full, depth + 1) }
              else if (item === info.name && Math.abs(stat.size - info.size) < 100) {
                found = full
                throw 'found'
              }
            } catch(e) { if (e === 'found') throw e }
          }
        }
        try { walk(dir, 0) } catch(e) { if (e === 'found') break }
      } catch(_) {}
      if (found) break
    }
    if (found) results.push(found)
  }
  return results
})

// ── 按文件类型列出所有文件 ──
ipcMain.handle('list-files-by-type', async (event, { vaultPath, type }) => {
  try {
    const extMap = {
      md:    ['.md'],
      pdf:   ['.pdf'],
      image: ['.png','.jpg','.jpeg','.gif','.webp'],
      video: ['.mp4','.mov','.avi','.mkv','.webm','.m4v'],
      other: null  // 其他：排除以上所有
    }
    const allExts = ['.md','.pdf','.png','.jpg','.jpeg','.gif','.webp','.mp4','.mov','.avi','.mkv','.webm','.m4v']
    const targetExts = extMap[type]
    const allFiles = []
    function walk(dir) {
      try {
        for (const item of fs.readdirSync(dir)) {
          if (item.startsWith('.')) continue
          const full = path.join(dir, item)
          const stat = fs.statSync(full)
          if (stat.isDirectory()) { walk(full) } else {
            const ext = path.extname(item).toLowerCase()
            const match = type === 'other'
              ? !allExts.includes(ext)
              : targetExts.includes(ext)
            if (match) allFiles.push({
              name: item, path: full,
              relativePath: path.relative(vaultPath, full),
              ext, mtime: stat.mtime.toISOString().slice(0, 10)
            })
          }
        }
      } catch (_) {}
    }
    walk(vaultPath)
    allFiles.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    return { success: true, files: allFiles }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 读取指定文件夹内文件（一层）──
ipcMain.handle('list-folder-files', async (event, { folderPath, vaultPath }) => {
  try {
    const items = fs.readdirSync(folderPath)
    const files = [], dirs = []
    for (const item of items) {
      if (item.startsWith('.')) continue
      const full = path.join(folderPath, item)
      const stat = fs.statSync(full)
      if (stat.isDirectory()) {
        dirs.push({ name: item, path: full, isDir: true })
      } else {
        files.push({ name: item, path: full, relativePath: path.relative(vaultPath, full), ext: path.extname(item).toLowerCase(), mtime: stat.mtime.toISOString().slice(0, 10), isDir: false })
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    return { success: true, items: [...dirs, ...files] }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 获取已处理文件夹信息 ──
ipcMain.handle('get-processed-folder', async (event, inboxPath) => {
  try {
    const processedDir = path.join(inboxPath, '已处理')
    if (!fs.existsSync(processedDir)) return { success: true, count: 0, size: 0 }
    const files = fs.readdirSync(processedDir).filter(f => !f.startsWith('.'))
    let size = 0
    files.forEach(f => { try { size += fs.statSync(path.join(processedDir, f)).size } catch (_) {} })
    return { success: true, count: files.length, size, path: processedDir }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 清除已处理文件夹 ──
ipcMain.handle('clear-processed-folder', async (event, inboxPath) => {
  try {
    const processedDir = path.join(inboxPath, '已处理')
    if (!fs.existsSync(processedDir)) return { success: true, count: 0 }
    const files = fs.readdirSync(processedDir).filter(f => !f.startsWith('.'))
    let count = 0
    for (const f of files) {
      try {
        await shell.trashItem(path.join(processedDir, f))
        count++
      } catch (_) {
        try { fs.unlinkSync(path.join(processedDir, f)); count++ } catch (_) {}
      }
    }
    return { success: true, count }
  } catch (err) { return { success: false, error: err.message } }
})
ipcMain.handle('select-inbox', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: '选择待处理文件夹' })
  if (!result.canceled && result.filePaths.length > 0) {
    store.set('inboxPath', result.filePaths[0])
    return { success: true, path: result.filePaths[0] }
  }
  return { success: false }
})
ipcMain.handle('get-inbox-path', () => store.get('inboxPath', null))

// ── 列出待处理文件库文件 ──
ipcMain.handle('list-inbox-files', async (event, inboxPath) => {
  try {
    const files = []
    for (const item of fs.readdirSync(inboxPath)) {
      if (item.startsWith('.')) continue
      const full = path.join(inboxPath, item)
      const stat = fs.statSync(full)
      if (stat.isFile()) files.push({ name: item, path: full, size: stat.size, mtime: stat.mtime.toISOString().slice(0, 10), ext: path.extname(item).toLowerCase() })
    }
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    return { success: true, files }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 重复文件检测（按文件名+大小判断）──
ipcMain.handle('check-duplicate-files', async (event, vaultPath) => {
  try {
    const allFiles = getAllFiles(vaultPath)
    const map = {}
    for (const fp of allFiles) {
      try {
        const stat = fs.statSync(fp)
        const name = path.basename(fp).toLowerCase()
        const key = name + '|' + stat.size
        if (!map[key]) map[key] = []
        map[key].push({ name: path.basename(fp), path: fp, relativePath: path.relative(vaultPath, fp), size: stat.size, mtime: stat.mtime.toISOString().slice(0,10) })
      } catch (_) {}
    }
    const duplicates = Object.values(map).filter(g => g.length > 1)
    return { success: true, duplicates }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 空文件检测（内容为空或只有 frontmatter 的 md 文件）──
ipcMain.handle('check-empty-files', async (event, vaultPath) => {
  try {
    const allFiles = getAllFiles(vaultPath)
    const empty = []
    for (const fp of allFiles) {
      try {
        const stat = fs.statSync(fp)
        const ext = path.extname(fp).toLowerCase()
        let isEmpty = false
        if (stat.size === 0) {
          isEmpty = true
        } else if (ext === '.md') {
          const content = fs.readFileSync(fp, 'utf-8').trim()
          // 去掉 frontmatter 后看正文是否为空
          const withoutFm = content.replace(/^---[\s\S]*?---\n?/, '').trim()
          // 去掉标题行后看是否还有实质内容
          const withoutTitle = withoutFm.replace(/^#[^\n]*\n?/, '').trim()
          if (withoutTitle.length === 0) isEmpty = true
        }
        if (isEmpty) {
          empty.push({
            name: path.basename(fp),
            path: fp,
            relativePath: path.relative(vaultPath, fp),
            size: stat.size,
            mtime: stat.mtime.toISOString().slice(0, 10),
            ext
          })
        }
      } catch (_) {}
    }
    return { success: true, empty }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 删除文件（移到系统回收站）──
ipcMain.handle('delete-file', async (event, filePath) => {
  const folderPath = path.dirname(filePath)
  let deleted = false

  // 第一次尝试：Electron shell.trashItem
  try {
    await shell.trashItem(filePath)
    deleted = true
  } catch (_) {}

  // 第二次尝试：Windows PowerShell（对 Unicode 路径更友好）
  if (!deleted && isWin) {
    try {
      const { execSync } = require('child_process')
      // 用 PowerShell 把文件移入回收站
      const escaped = filePath.replace(/'/g, "''")
      execSync(
        `powershell -NoProfile -Command "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${escaped}', 'OnlyErrorDialogs', 'SendToRecycleBin')"`,
        { timeout: 10000 }
      )
      deleted = true
    } catch (_) {}
  }

  // 第三次尝试：直接删除（不进回收站，最后兜底）
  if (!deleted) {
    try {
      fs.unlinkSync(filePath)
      deleted = true
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  // 删除后触发 Hub 更新
  try {
    const settings = store.get('aiSettings', {})
    const vaultPath = store.get('vaultPath', '')
    if (vaultPath) updateHubFile(folderPath, vaultPath, settings)
  } catch (_) {}

  return { success: true }
})

// ── 新建文件夹 ──
ipcMain.handle('create-folder', async (event, { parentPath, folderName }) => {
  try {
    const folderName2 = (folderName || '').trim()
    if (!folderName2) return { success: false, error: '文件夹名称不能为空' }
    // 过滤非法字符
    const invalid = /[\\/:*?"<>|]/
    if (invalid.test(folderName2)) return { success: false, error: '文件夹名称包含非法字符' }
    const newPath = path.join(parentPath, folderName2)
    if (fs.existsSync(newPath)) return { success: false, error: '该文件夹已存在' }
    fs.mkdirSync(newPath, { recursive: true })
    return { success: true, path: newPath }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 删除文件夹（移入回收站） ──
ipcMain.handle('delete-folder', async (event, { folderPath }) => {
  try {
    if (!fs.existsSync(folderPath)) return { success: false, error: '文件夹不存在' }
    const stat = fs.lstatSync(folderPath)
    if (!stat.isDirectory()) return { success: false, error: '不是文件夹' }
    await shell.trashItem(folderPath)
    return { success: true }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 移动文件到指定文件夹 ──
ipcMain.handle('move-file', async (event, { srcPath, destDir }) => {
  try {
    const fileName = path.basename(srcPath)
    let destPath = path.join(destDir, fileName)
    // 目标已存在时加时间戳后缀避免覆盖
    if (fs.existsSync(destPath)) {
      const ext = path.extname(fileName)
      const base = path.basename(fileName, ext)
      const ts = Date.now()
      destPath = path.join(destDir, `${base}_${ts}${ext}`)
    }
    fs.renameSync(srcPath, destPath)
    // 移动后触发源文件夹和目标文件夹的 Hub 更新
    const settings = store.get('aiSettings', {})
    const vaultPath = store.get('vaultPath', '')
    if (vaultPath) {
      updateHubFile(path.dirname(srcPath), vaultPath, settings)
      updateHubFile(destDir, vaultPath, settings)
    }
    return { success: true, destPath }
  } catch (err) { return { success: false, error: err.message } }
})
// ══════════════════════════════════════════════
// ── Hub 文件自动维护系统 ──
// ══════════════════════════════════════════════

// Hub 文件名候选列表（按优先级）
const HUB_FILENAME_CANDIDATES = ['Hub.md', 'readme.md', 'README.md', 'index.md', 'MOC.md']

// 判断某个路径是否是临时文件夹（inbox）
function isTempFolder(folderPath, settings) {
  const inboxFolder = settings.inboxFolder || ''
  if (!inboxFolder) return false
  const norm = p => p.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '')
  return norm(folderPath) === norm(inboxFolder) ||
         norm(folderPath).startsWith(norm(inboxFolder) + '/')
}

// 判断某个文件夹是否应该有 Hub（排除临时文件夹和根目录）
function shouldHaveHub(folderPath, vaultPath, settings) {
  const norm = p => p.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '')
  // 排除根目录
  if (norm(folderPath) === norm(vaultPath)) return false
  // 排除临时文件夹
  if (isTempFolder(folderPath, settings)) return false
  // 排除 Templates 等常见系统文件夹
  const folderName = path.basename(folderPath).toLowerCase()
  if (['templates', 'attachments', '附件', 'assets', '.obsidian'].includes(folderName)) return false
  return true
}

// 找到文件夹里的 Hub 文件，返回路径（不存在返回 null）
function findExistingHubFile(folderPath, settings) {
  // 先看用户自定义的 Hub 文件名
  const customNames = (settings.hubFilenames || '')
    .split(',').map(s => s.trim()).filter(Boolean)
  const candidates = customNames.length
    ? customNames
    : HUB_FILENAME_CANDIDATES

  // 先检查固定候选名
  for (const name of candidates) {
    const p = path.join(folderPath, name)
    if (fs.existsSync(p)) return p
  }

  // 再扫描文件夹，找 "* Hub.md" 格式的文件（如 Claude Hub.md、AI Hub.md）
  try {
    const files = fs.readdirSync(folderPath)
    for (const f of files) {
      if (f.toLowerCase().endsWith(' hub.md') || f.toLowerCase() === 'hub.md') {
        return path.join(folderPath, f)
      }
    }
  } catch (_) {}

  return null
}

// 找到或创建 Hub 文件
function findOrCreateHubFile(folderPath, settings) {
  const existing = findExistingHubFile(folderPath, settings)
  if (existing) return existing

  // 自动创建：用文件夹名生成 Hub 文件名
  const folderName = path.basename(folderPath)
  // 去掉前面的数字序号，如 "01 AI" -> "AI"
  const cleanName = folderName.replace(/^\d+\s+/, '')
  const hubFileName = cleanName + ' Hub.md'
  const hubPath = path.join(folderPath, hubFileName)

  // 创建初始内容
  const initialContent = `---\n---\n\n# 📁 ${cleanName}\n\n`
  fs.writeFileSync(hubPath, initialContent, 'utf-8')
  return hubPath
}

// 判断文件是否应该被 Hub 收录
function shouldIncludeInHub(filePath, hubFilePath, settings) {
  const fileName = path.basename(filePath)
  const ext = path.extname(fileName).toLowerCase()

  // 只收录 md 文件
  if (ext !== '.md') return false

  // 排除 Hub 文件本身
  if (filePath === hubFilePath) return false

  // 排除常见系统文件
  const lname = fileName.toLowerCase()
  if (['readme.md', 'index.md', 'moc.md'].includes(lname)) return false
  if (lname.endsWith(' hub.md') || lname === 'hub.md') return false

  // 排除空文件
  try {
    const stat = fs.lstatSync(filePath)
    if (stat.size === 0) return false
    const content = fs.readFileSync(filePath, 'utf-8')
    const body = content.replace(/^---[\s\S]*?---\r?\n?/, '').trim()
    if (!body) return false
  } catch (_) { return false }

  return true
}

// 更新某个文件夹的 Hub 文件
function updateHubFile(folderPath, vaultPath, settings) {
  try {
    if (!shouldHaveHub(folderPath, vaultPath, settings)) return { updated: false, reason: 'skip' }

    const hubPath = findOrCreateHubFile(folderPath, settings)

    // 扫描文件夹里的直接 md 文件（不含子文件夹）
    let mdFiles = []
    try {
      mdFiles = fs.readdirSync(folderPath)
        .filter(f => !f.startsWith('.') && !f.endsWith('.icloud'))
        .map(f => path.join(folderPath, f))
        .filter(f => {
          try { return fs.lstatSync(f).isFile() } catch (_) { return false }
        })
        .filter(f => shouldIncludeInHub(f, hubPath, settings))
    } catch (_) {}

    // 读取当前 Hub 内容
    let hubContent = ''
    try { hubContent = fs.readFileSync(hubPath, 'utf-8') } catch (_) {}

    // 提取 frontmatter 和正文
    const fmMatch = hubContent.match(/^---[\s\S]*?---\r?\n?/)
    const frontmatter = fmMatch ? fmMatch[0] : '---\n---\n\n'
    const bodyWithoutFm = fmMatch ? hubContent.slice(fmMatch[0].length) : hubContent

    // 提取已有的 wikilinks
    const existingLinks = new Set()
    const wikilinkRegex = /\[\[([^\]|#]+?)(?:\|[^\]]*?)?\]\]/g
    let m
    while ((m = wikilinkRegex.exec(bodyWithoutFm)) !== null) {
      existingLinks.add(m[1].trim())
    }

    // 找出需要新增的文件
    const toAdd = mdFiles.filter(f => {
      const nameWithoutExt = path.basename(f, '.md')
      return !existingLinks.has(nameWithoutExt) && !existingLinks.has(path.basename(f))
    })

    // 找出需要移除的链接（文件已不存在）
    const toRemove = new Set()
    existingLinks.forEach(linkName => {
      const withExt = path.join(folderPath, linkName + '.md')
      const withoutExt = path.join(folderPath, linkName)
      if (!fs.existsSync(withExt) && !fs.existsSync(withoutExt)) {
        toRemove.add(linkName)
      }
    })

    if (toAdd.length === 0 && toRemove.size === 0) return { updated: false, reason: 'no-change' }

    // 处理正文：移除失效链接
    let newBody = bodyWithoutFm
    if (toRemove.size > 0) {
      toRemove.forEach(linkName => {
        // 移除整行包含该 wikilink 的行
        const escaped = linkName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        newBody = newBody.replace(new RegExp(`^[\\s\\-*]*\\[\\[${escaped}[\\]|].*$\\n?`, 'gm'), '')
      })
      // 清理多余空行
      newBody = newBody.replace(/\n{3,}/g, '\n\n')
    }

    // 添加新链接：找到「## 最近添加」章节，没有就创建
    if (toAdd.length > 0) {
      const newLinks = toAdd.map(f => `* [[${path.basename(f, '.md')}]]`).join('\n')
      const recentSection = '\n\n## 最近添加\n'
      if (newBody.includes('## 最近添加')) {
        // 在「最近添加」章节末尾插入
        newBody = newBody.replace(/(## 最近添加\n)([\s\S]*?)(\n##|$)/, (match, header, content, next) => {
          return header + content.trimEnd() + '\n' + newLinks + '\n' + next
        })
      } else {
        // 追加「最近添加」章节
        newBody = newBody.trimEnd() + recentSection + newLinks + '\n'
      }
    }

    // 写回文件
    fs.writeFileSync(hubPath, frontmatter + newBody, 'utf-8')
    return { updated: true, added: toAdd.length, removed: toRemove.size, hubPath }

  } catch (err) {
    return { updated: false, error: err.message }
  }
}

// 根据文件路径触发对应文件夹的 Hub 更新
function triggerHubUpdate(filePath, vaultPath, settings) {
  try {
    const folderPath = path.dirname(filePath)
    return updateHubFile(folderPath, vaultPath, settings)
  } catch (_) { return { updated: false } }
}

// 批量补全：扫描整个知识库所有应有 Hub 的文件夹
function batchUpdateAllHubs(vaultPath, settings) {
  const results = []
  const walk = (dir) => {
    try {
      for (const item of fs.readdirSync(dir)) {
        if (item.startsWith('.') || item.endsWith('.icloud')) continue
        const full = path.join(dir, item)
        try {
          if (fs.lstatSync(full).isDirectory()) {
            if (shouldHaveHub(full, vaultPath, settings)) {
              const res = updateHubFile(full, vaultPath, settings)
              if (res.updated || res.error) results.push({ folder: item, ...res })
            }
            walk(full)
          }
        } catch (_) {}
      }
    } catch (_) {}
  }
  walk(vaultPath)
  return results
}

// ── IPC Handlers ──

// 批量补全 Hub
ipcMain.handle('hub-batch-update', async (event, vaultPath) => {
  const settings = store.get('aiSettings', {})
  try {
    const results = batchUpdateAllHubs(vaultPath, settings)
    const updated = results.filter(r => r.updated)
    return { success: true, updatedCount: updated.length, results }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// 扫描 Hub 状态（只扫描，不修改）
ipcMain.handle('hub-scan', async (event, vaultPath) => {
  const settings = store.get('aiSettings', {})
  try {
    const items = []
    const walk = (dir) => {
      try {
        for (const item of fs.readdirSync(dir)) {
          if (item.startsWith('.') || item.endsWith('.icloud')) continue
          const full = path.join(dir, item)
          try {
            if (!fs.lstatSync(full).isDirectory()) continue
            if (!shouldHaveHub(full, vaultPath, settings)) continue
            const hubPath = findExistingHubFile(full, settings)
            // 扫描文件夹里的 md 文件
            let mdFiles = []
            try {
              mdFiles = fs.readdirSync(full)
                .filter(f => !f.startsWith('.') && !f.endsWith('.icloud'))
                .map(f => path.join(full, f))
                .filter(f => { try { return fs.lstatSync(f).isFile() } catch (_) { return false } })
                .filter(f => hubPath ? shouldIncludeInHub(f, hubPath, settings) : path.extname(f).toLowerCase() === '.md')
            } catch (_) {}

            if (!hubPath) {
              // 没有 Hub 文件，需要创建
              if (mdFiles.length > 0) {
                items.push({
                  folderPath: full,
                  folderName: path.basename(full),
                  relativePath: path.relative(vaultPath, full),
                  status: 'create',
                  statusLabel: '需要创建',
                  mdCount: mdFiles.length
                })
              }
            } else {
              // 有 Hub 文件，检查是否需要更新
              const hubContent = fs.readFileSync(hubPath, 'utf-8')
              const existingLinks = new Set()
              const re = /\[\[([^\]|#]+?)(?:\|[^\]]*?)?\]\]/g
              let m
              while ((m = re.exec(hubContent)) !== null) existingLinks.add(m[1].trim())
              const toAdd = mdFiles.filter(f => {
                const n = path.basename(f, '.md')
                return !existingLinks.has(n) && !existingLinks.has(path.basename(f))
              })
              const toRemove = []
              existingLinks.forEach(linkName => {
                const p1 = path.join(full, linkName + '.md')
                const p2 = path.join(full, linkName)
                if (!fs.existsSync(p1) && !fs.existsSync(p2)) toRemove.push(linkName)
              })
              if (toAdd.length > 0 || toRemove.length > 0) {
                items.push({
                  folderPath: full,
                  folderName: path.basename(full),
                  relativePath: path.relative(vaultPath, full),
                  status: 'update',
                  statusLabel: '需要更新',
                  addCount: toAdd.length,
                  removeCount: toRemove.length,
                  hubPath
                })
              }
            }
            walk(full)
          } catch (_) {}
        }
      } catch (_) {}
    }
    walk(vaultPath)
    return { success: true, items }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// 对选中的文件夹执行 Hub 更新
ipcMain.handle('hub-update-selected', async (event, { folderPaths, vaultPath }) => {
  const settings = store.get('aiSettings', {})
  const results = []
  for (const folderPath of folderPaths) {
    try {
      const res = updateHubFile(folderPath, vaultPath, settings)
      results.push({ folderPath, folderName: path.basename(folderPath), ...res })
    } catch (err) {
      results.push({ folderPath, folderName: path.basename(folderPath), updated: false, error: err.message })
    }
  }
  const updatedCount = results.filter(r => r.updated).length
  return { success: true, updatedCount, results }
})


// ── 扫描缺少标签的笔记 ──
ipcMain.handle('scan-missing-summary', async (event, { scanPath, vaultPath }) => {
  try {
    const files = []
    const walk = (dir) => {
      for (const item of fs.readdirSync(dir)) {
        if (item.startsWith('.') || item.endsWith('.icloud')) continue
        const full = path.join(dir, item)
        const stat = fs.lstatSync(full)
        if (stat.isDirectory()) { walk(full); continue }
        if (!item.endsWith('.md')) continue
        // 排除 Hub 文件（导航索引文件不需要标签）
        const lname = item.toLowerCase()
        if (lname.endsWith(' hub.md') || lname === 'hub.md' || lname === 'readme.md' || lname === 'index.md' || lname === 'moc.md') continue
        const content = fs.readFileSync(full, 'utf-8')
        // 检查是否有 tags 字段且不为空
        const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        if (fmMatch) {
          const fm = fmMatch[1]
          const tagsMatch = fm.match(/^tags\s*:/m)
          if (tagsMatch) {
            // 有 tags 字段，检查是否有实际内容（不是空数组 []）
            const tagsLine = fm.match(/^tags\s*:\s*(.+)$/m)
            if (tagsLine && tagsLine[1].trim() !== '[]' && tagsLine[1].trim() !== '') continue
            // 检查多行格式
            const tagsBlock = fm.match(/^tags\s*:\s*\n((?:\s+-\s*.+\n?)+)/m)
            if (tagsBlock) continue
          }
        }
        // 文件内容太少（少于50字）跳过
        const body = content.replace(/^---[\s\S]*?---\r?\n?/, '').trim()
        if (body.length < 50) continue
        files.push({
          name: item,
          path: full,
          relativePath: path.relative(vaultPath, full)
        })
      }
    }
    walk(scanPath)
    return { success: true, files }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 为单篇笔记写入 AI 标签 ──
ipcMain.handle('write-summary', async (event, { filePath }) => {
  const settings = store.get('aiSettings', {})
  if (!settings.apiKey || !settings.modelId) {
    return { success: false, error: '请先配置 API Key' }
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const body = raw.replace(/^---[\s\S]*?---\r?\n?/, '').trim().slice(0, 2000)
    if (!body) return { success: false, error: '文件内容为空' }

    const fileName = path.basename(filePath, '.md')
    const folderName = path.dirname(filePath).split(path.sep).pop()
    const prompt = `你是知识库标签助手。请根据以下笔记内容，推断1到3个合适的中文标签（参考文件夹名称判断领域）。
只输出标签，用英文逗号分隔，不要加[]或引号，不要解释。

文件名：${fileName}
所在文件夹：${folderName}
内容摘录：
${body}`

    const replyObj1 = await callVolcanoAI(
      settings.apiKey, settings.modelId, settings.endpoint,
      [{ role: 'user', content: prompt }], 100
    )
    recordTokenUsage('tag', 'text', replyObj1.usage.prompt_tokens||0, replyObj1.usage.completion_tokens||0)
    const tagsStr = (replyObj1.content||'').trim().replace(/[\[\]"']/g, '').trim()
    if (!tagsStr) return { success: false, error: 'AI 返回空内容' }
    const tags = tagsStr.split(/[,，]/).map(t => t.trim()).filter(Boolean)
    if (!tags.length) return { success: false, error: '未能解析出标签' }

    const tagsYaml = '[' + tags.map(t => t).join(', ') + ']'

    // 写入 frontmatter
    let newContent
    if (raw.match(/^---\r?\n/)) {
      newContent = raw.replace(/^(---\r?\n)([\s\S]*?)(\r?\n---)/,
        (_, open, fm, close) => {
          const cleaned = fm.replace(/^tags\s*:.*$/m, '').replace(/\n+$/, '')
          return `${open}${cleaned}\ntags: ${tagsYaml}${close}`
        }
      )
    } else {
      newContent = `---\ntags: ${tagsYaml}\n---\n\n${raw}`
    }
    fs.writeFileSync(filePath, newContent, 'utf-8')
    return { success: true, tags }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 标签统计（只读 frontmatter，不扫正文）──
ipcMain.handle('get-tag-stats', async (event, vaultPath) => {
  try {
    const allMdFiles = getAllFiles(vaultPath, '.md')
    const tagCount = {}
    for (const filePath of allMdFiles) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8')
        const fmMatch = content.match(/^---[\s\S]*?^---/m)
        if (!fmMatch) continue
        const fm = fmMatch[0]
        // tags: [a, b, c] 格式
        const tagLine = fm.match(/tags:\s*\[([^\]]+)\]/)
        if (tagLine) {
          tagLine[1].split(',').forEach(t => {
            const tag = t.trim().replace(/['"]/g, '')
            if (tag) tagCount[tag] = (tagCount[tag] || 0) + 1
          })
        }
        // tags: 列表格式
        const tagLines = fm.match(/tags:([\s\S]*?)(?=\n\w|\n---)/m)
        if (tagLines) {
          ;(tagLines[1].match(/- .+/g) || []).forEach(t => {
            const tag = t.replace('- ', '').trim()
            if (tag) tagCount[tag] = (tagCount[tag] || 0) + 1
          })
        }
      } catch (_) {}
    }
    return { success: true, tags: Object.entries(tagCount).sort((a,b)=>b[1]-a[1]).map(([tag,count])=>({tag,count})) }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 按标签查找笔记（只读 frontmatter）──
ipcMain.handle('search-by-tag', async (event, { vaultPath, tag }) => {
  try {
    const allMdFiles = getAllFiles(vaultPath, '.md')
    const results = [], tagLower = tag.toLowerCase()
    for (const filePath of allMdFiles) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8')
        const fmMatch = content.match(/^---[\s\S]*?^---/m)
        if (!fmMatch) continue
        const fm = fmMatch[0]
        let matched = false
        const tagLine = fm.match(/tags:\s*\[([^\]]+)\]/)
        if (tagLine && tagLine[1].split(',').map(t=>t.trim().replace(/['"]/g,'').toLowerCase()).includes(tagLower)) matched = true
        if (!matched) {
          const tagLines = fm.match(/tags:([\s\S]*?)(?=\n\w|\n---)/m)
          if (tagLines && (tagLines[1].match(/- .+/g)||[]).map(t=>t.replace('- ','').trim().toLowerCase()).includes(tagLower)) matched = true
        }
        if (matched) results.push({ name: path.basename(filePath,'.md'), path: filePath, relativePath: path.relative(vaultPath, filePath) })
      } catch (_) {}
    }
    return { success: true, results }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 设置：保存/读取 AI 配置 ──
ipcMain.handle('save-ai-settings', async (event, settings) => {
  store.set('aiSettings', settings)
  return { success: true }
})
// ── Token 使用统计 ──
function recordTokenUsage(feature, modelType, inputTokens, outputTokens) {
  try {
    const today = new Date().toISOString().slice(0, 10)
    const logs = store.get('tokenLogs', [])
    logs.push({ date: today, feature, modelType, inputTokens: inputTokens||0, outputTokens: outputTokens||0 })
    // 只保留最近 30 天
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 30)
    const cutoffStr = cutoff.toISOString().slice(0, 10)
    const trimmed = logs.filter(l => l.date >= cutoffStr)
    store.set('tokenLogs', trimmed)
  } catch(_) {}
}

ipcMain.handle('get-token-stats', () => {
  const logs = store.get('tokenLogs', [])
  const today = new Date().toISOString().slice(0, 10)
  const d7 = new Date(); d7.setDate(d7.getDate() - 7); const d7str = d7.toISOString().slice(0, 10)
  const d30 = new Date(); d30.setDate(d30.getDate() - 30); const d30str = d30.toISOString().slice(0, 10)

  function sum(filtered) {
    const r = { text: { input: 0, output: 0 }, audio: { input: 0, output: 0 }, byFeature: {} }
    for (const l of filtered) {
      if (l.modelType === 'audio') { r.audio.input += l.inputTokens; r.audio.output += l.outputTokens }
      else { r.text.input += l.inputTokens; r.text.output += l.outputTokens }
      if (!r.byFeature[l.feature]) r.byFeature[l.feature] = { input: 0, output: 0 }
      r.byFeature[l.feature].input += l.inputTokens
      r.byFeature[l.feature].output += l.outputTokens
    }
    return r
  }

  return {
    today: sum(logs.filter(l => l.date === today)),
    week:  sum(logs.filter(l => l.date >= d7str)),
    month: sum(logs.filter(l => l.date >= d30str))
  }
})

ipcMain.handle('get-ai-settings', () => {
  return store.get('aiSettings', {
    apiKey: '',
    modelId: '',
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
    audioModelId: '',
    audioApiKey: '',
    audioEndpoint: 'https://ark.cn-beijing.volces.com/api/v3',
    aiClassifyEnabled: false,
    reminderEnabled: false,
    reminderAdvance: 0,
    inboxFolder: '',
    ytCookiesFile: '',
    hubCustomEnabled: false,
    hubFilenames: ''
  })
})

// ── 设置：选择临时文件夹 ──
ipcMain.handle('select-inbox-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'], title: '选择临时文件夹（无法分类的文件存放位置）'
  })
  if (!result.canceled && result.filePaths.length > 0) {
    return { success: true, path: result.filePaths[0] }
  }
  return { success: false }
})

// ── AI 调用（火山引擎）──
function callVolcanoAI(apiKey, modelId, endpoint, messages, maxTokens) {
  const timeoutMs = 120000
  const apiCall = new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: modelId, messages, max_tokens: maxTokens || 500 })
    const url = new URL(endpoint + '/chat/completions')
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(body)
      }
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          resolve({ content: json.choices?.[0]?.message?.content || '', usage: json.usage || {} })
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('AI 请求超时（120秒），内容可能过长，请减少文件数量')), timeoutMs)
  )
  return Promise.race([apiCall, timeout])
}

// ── AI 分类单个文件 ──
ipcMain.handle('ai-classify-file', async (event, { filePath, vaultPath, vaultFolders }) => {
  const settings = store.get('aiSettings', {})
  if (!settings.apiKey || !settings.modelId) return { success: false, error: '未设置 API Key 或模型ID' }

  const ext = path.extname(filePath).toLowerCase()
  const fileName = path.basename(filePath)
  const isText = ['.md', '.txt'].includes(ext)
  const isPdf = ext === '.pdf'
  const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)

  let contentForAI = `文件名：${fileName}`

  // md/txt 读取正文
  if (isText) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const body = raw.replace(/^---[\s\S]*?---\n?/, '').trim().slice(0, 1500)
      contentForAI += `\n正文内容（前1500字）：\n${body}`
    } catch (_) {}
  }

  // PDF 提取文字
  if (isPdf) {
    const pdfText = await extractPdfText(filePath, 1500)
    if (pdfText) contentForAI += `\nPDF内容（前1500字）：\n${pdfText}`
  }

  // 图片：用 Doubao 视觉模型描述内容
  if (isImage) {
    const audioApiKey = settings.audioApiKey || settings.apiKey
    const audioModelId = settings.audioModelId || ''
    const audioEndpoint = settings.audioEndpoint || settings.endpoint
    if (audioApiKey && audioModelId) {
      try {
        const visionPrompt = '请简要描述这张图片的主要内容，重点说明涉及的学科、主题或知识领域（如数学、化学、英语等），50字以内。'
        const visionRes = await callDoubaoVision(audioApiKey, audioModelId, audioEndpoint, filePath, visionPrompt)
        if (visionRes.content) {
          contentForAI += `\n图片内容描述：\n${visionRes.content}`
          recordTokenUsage('classify', 'vision', visionRes.usage.prompt_tokens||0, visionRes.usage.completion_tokens||0)
        }
      } catch (_) {}
    }
  }

  // 构建知识库文件夹列表
  const folderList = vaultFolders.map(f => f.label).filter(l => l !== '（根目录）').join('、')

  const prompt = `你是一个知识库文件分类助手。
知识库现有文件夹：${folderList}
请根据以下文件信息，判断：
1. 最适合存放的文件夹路径（从上面的列表中选择，输出相对路径，如"01 AI/Claude"）
2. 适合的标签（可自由生成，用逗号分隔，中文）
3. 如果是md文件且没有标题，建议一个标题（不超过20字）

文件信息：
${contentForAI}

请严格按以下JSON格式回复，不要加任何其他文字：
{"folder":"xxx","tags":"xxx,xxx","title":"xxx"}`

  try {
    const replyObj2 = await callVolcanoAI(settings.apiKey, settings.modelId, settings.endpoint, [
      { role: 'user', content: prompt }
    ])
    recordTokenUsage('save', 'text', replyObj2.usage.prompt_tokens||0, replyObj2.usage.completion_tokens||0)
    const clean = (replyObj2.content||'').replace(/```json|```/g, '').trim()
    const result = JSON.parse(clean)
    return { success: true, folder: result.folder, tags: result.tags, title: result.title }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ── 导入并 AI 分类（批量，并行处理）──
ipcMain.handle('ai-import-files', async (event, { files, vaultPath, vaultFolders }) => {
  const settings = store.get('aiSettings', {})

  // 临时文件夹：用户设置了就用，没设置则自动创建 00 Inbox 并写入设置
  let inboxFolder = settings.inboxFolder || ''
  if (!inboxFolder) {
    inboxFolder = path.join(vaultPath, '00 Inbox')
    if (!fs.existsSync(inboxFolder)) fs.mkdirSync(inboxFolder, { recursive: true })
    // 写入设置，下次直接用
    const updatedSettings = { ...settings, inboxFolder }
    store.set('aiSettings', updatedSettings)
  }

  // 并行处理所有文件
  const results = await Promise.all(files.map(async srcPath => {
    try {
      const ext = path.extname(srcPath).toLowerCase()
      const fileName = path.basename(srcPath)
      const isText = ['.md', '.txt'].includes(ext)
      const srcInInbox = path.normalize(path.dirname(srcPath)) === path.normalize(inboxFolder)

      // 检查是否为空文件，空文件直接存 inbox 不调 AI
      let isEmpty = false
      if (isText) {
        try {
          const raw = fs.readFileSync(srcPath, 'utf-8').trim()
          const body = raw.replace(/^---[\s\S]*?---\n?/, '').replace(/^#[^\n]*\n?/, '').trim()
          if (body.length < 10) isEmpty = true
        } catch (_) {}
      }

      let targetDir = null  // null 表示"留在原地"
      let aiFolder = ''
      let aiTags = ''
      let aiTitle = ''
      let stayed = false  // 是否留在临时文件夹未移动

      if (isEmpty) {
        // 空文件：若来自临时文件夹则留在原地，否则移入临时文件夹
        if (srcInInbox) {
          stayed = true
          aiFolder = '临时文件夹（内容为空，保留原位）'
        } else {
          targetDir = inboxFolder
          aiFolder = '临时文件夹（内容为空）'
        }
      } else {
        // 调 AI 分类
        const classify = await (async () => {
          try {
            if (!settings.apiKey || !settings.modelId) return null
            const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp']
            const isImage = imageExts.includes(ext)
            let contentForAI = `文件名：${fileName}`

            if (isText) {
              const raw = fs.readFileSync(srcPath, 'utf-8')
              const body = raw.replace(/^---[\s\S]*?---\n?/, '').trim().slice(0, 1500)
              contentForAI += `\n正文内容：\n${body}`
            } else if (ext === '.pdf') {
              const pdfText = await extractPdfText(srcPath, 1500)
              if (pdfText) contentForAI += `\nPDF内容：\n${pdfText}`
            } else if (isImage) {
              // 图片：先用 Doubao 视觉模型描述图片内容，再用文字模型分类
              const audioApiKey = settings.audioApiKey || settings.apiKey
              const audioModelId = settings.audioModelId || ''
              const audioEndpoint = settings.audioEndpoint || settings.endpoint
              if (audioApiKey && audioModelId) {
                try {
                  const visionPrompt = '请简要描述这张图片的主要内容，重点说明涉及的学科、主题或知识领域（如数学、化学、英语等），50字以内。'
                  const visionRes = await callDoubaoVision(audioApiKey, audioModelId, audioEndpoint, srcPath, visionPrompt)
                  if (visionRes.content) {
                    contentForAI += `\n图片内容描述：\n${visionRes.content}`
                    recordTokenUsage('classify', 'vision', visionRes.usage.prompt_tokens||0, visionRes.usage.completion_tokens||0)
                  }
                } catch (_) {
                  // 视觉识别失败则仅靠文件名分类，不中断流程
                }
              }
            }

            const folderList = vaultFolders.map(f => f.label).filter(l => l !== '（根目录）').join('、')
            const prompt = `你是知识库分类助手。知识库文件夹：${folderList}\n根据以下文件信息判断：1.存放文件夹（输出相对路径如"01 AI/Claude"）2.标签（中文逗号分隔）3.md文件无标题则建议标题（20字内）\n文件信息：${contentForAI}\n只输出JSON：{"folder":"xxx","tags":"xxx","title":"xxx"}`
            const replyObj3 = await callVolcanoAI(settings.apiKey, settings.modelId, settings.endpoint, [{ role: 'user', content: prompt }])
            recordTokenUsage('classify', 'text', replyObj3.usage.prompt_tokens||0, replyObj3.usage.completion_tokens||0)
            const clean = (replyObj3.content||'').replace(/```json|```/g, '').trim()
            return JSON.parse(clean)
          } catch (_) { return null }
        })()

        if (classify && classify.folder) {
          const matched = vaultFolders.find(f => f.label === classify.folder || f.value.endsWith(classify.folder))
          if (matched) {
            targetDir = matched.value
            aiFolder = classify.folder
          } else {
            // 路径未匹配：若已在临时文件夹则留在原地，否则移入临时文件夹
            if (srcInInbox) { stayed = true; aiFolder = '临时文件夹（路径未匹配，保留原位）' }
            else { targetDir = inboxFolder; aiFolder = '临时文件夹（路径未匹配）' }
          }
          aiTags = classify.tags || ''
          aiTitle = classify.title || ''
        } else {
          // AI 无法判断：若已在临时文件夹则留在原地，否则移入临时文件夹
          if (srcInInbox) { stayed = true; aiFolder = '临时文件夹（AI无法判断，保留原位）' }
          else { targetDir = inboxFolder; aiFolder = '临时文件夹（AI无法判断）' }
        }
      }

      // 执行移动
      let finalPath = srcPath
      if (!stayed && targetDir) {
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true })
        let destPath = path.join(targetDir, fileName)
        // 同名文件加时间戳避免冲突
        if (fs.existsSync(destPath) && path.normalize(destPath) !== path.normalize(srcPath)) {
          const ts = Date.now()
          const base = path.basename(fileName, ext)
          destPath = path.join(targetDir, `${base}_${ts}${ext}`)
        }
        fs.renameSync(srcPath, destPath)
        finalPath = destPath

        // 更新 md 文件 frontmatter（移动后在目标位置写）
        if (ext === '.md' && (aiTags || aiTitle)) {
          try {
            let content = fs.readFileSync(finalPath, 'utf-8')
            const date = new Date().toISOString().slice(0, 10)
            const tagsArr = aiTags ? aiTags.split(',').map(t => t.trim()).filter(Boolean) : []
            const tagsYaml = tagsArr.length ? `[${tagsArr.join(', ')}]` : '[]'
            if (content.startsWith('---')) {
              if (aiTags && !content.match(/^tags:/m)) {
                content = content.replace(/^---/, `---\ntags: ${tagsYaml}`)
              }
            } else {
              const title = aiTitle || path.basename(srcPath, '.md')
              content = `---\ntitle: ${title}\ndate: ${date}\ntags: ${tagsYaml}\n---\n\n${content}`
            }
            fs.writeFileSync(finalPath, content, 'utf-8')
          } catch (_) {}
        }
      }

      return { file: fileName, success: true, targetDir: targetDir || inboxFolder, aiFolder, aiTags, aiTitle, isEmpty, stayed }
    } catch (err) {
      return { file: path.basename(srcPath), success: false, error: err.message }
    }
  }))

  // 导入完成后，触发所有涉及文件夹的 Hub 更新
  const hubSettings = store.get('aiSettings', {})
  const affectedDirs = new Set(results.filter(r => r.success).map(r => r.targetDir).filter(Boolean))
  affectedDirs.forEach(dir => {
    try { updateHubFile(dir, vaultPath, hubSettings) } catch (_) {}
  })

  return results
})

// ── 移动笔记 ──
ipcMain.handle('move-note', async (event, { srcPath, targetDir }) => {
  try {
    const fileName = path.basename(srcPath)
    const destPath = path.join(targetDir, fileName)
    if (fs.existsSync(destPath)) return { success: false, error: '目标位置已存在同名文件' }
    fs.renameSync(srcPath, destPath)
    return { success: true, path: destPath }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 新建笔记 ──
ipcMain.handle('create-note', async (event, { vaultPath, targetDir, title, template, body }) => {
  try {
    const now = new Date()
    const date = now.toISOString().slice(0, 10)
    const time = now.toTimeString().slice(0, 5)
    const safeTitle = title || now.toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '-')
    const bodyText = body ? '\n' + body + '\n' : '\n'
    let content = ''
    if (template === 'daily') {
      content = `---\ndate: ${date}\ntype: 今日备忘\ntags: [今日备忘]\n---\n\n# ${date} 今日备忘\n\n## ✅ 今日待办\n${bodyText}\n## 📝 今日记录\n\n\n## 📌 明日计划\n\n`
    } else if (template === 'book') {
      content = `---\ndate: ${date}\ntype: 读书笔记\ntags: [读书笔记]\ntitle: ${safeTitle}\n---\n\n# 《${safeTitle}》读书笔记\n\n## 基本信息\n- 作者：\n- 阅读日期：${date}\n\n## 核心观点\n\n\n## 摘录\n${bodyText}\n## 读后感\n\n`
    } else if (template === 'meeting') {
      // 会议记录：有标题用标题，没有标题用"会议记录 日期"
      const meetingTitle = title ? title : `会议记录 ${date}`
      const safeM = meetingTitle
      content = `---\ndate: ${date}\ntype: 会议记录\ntags: [会议记录]\ntitle: ${safeM}\n---\n\n# ${safeM}\n\n## 参与人员\n\n\n## 会议议题\n\n\n## 讨论内容\n${bodyText}\n## 待办事项\n\n`
    } else {
      content = `---\ndate: ${date}\ntags: []\ntitle: ${safeTitle}\n---\n\n# ${safeTitle}\n${bodyText}`
    }
    // 会议记录文件名也用会议标题
    const fileName = template === 'daily'
      ? `${date}.md`
      : template === 'meeting' && title
        ? `${title}.md`
        : template === 'meeting'
          ? `会议记录 ${date}.md`
          : `${safeTitle}.md`
    const filePath = path.join(targetDir || vaultPath, fileName)
    if (fs.existsSync(filePath)) return { success: false, error: '同名文件已存在' }
    fs.writeFileSync(filePath, content, 'utf-8')
    // 保存笔记后触发 Hub 更新
    const noteSettings = store.get('aiSettings', {})
    try { updateHubFile(targetDir || vaultPath, vaultPath, noteSettings) } catch (_) {}
    return { success: true, path: filePath }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 工具函数 ──
function getAllFiles(dir, ext) {
  let results = []
  try {
    for (const item of fs.readdirSync(dir)) {
      if (item.startsWith('.')) continue
      if (item.endsWith('.icloud')) continue // 跳过 iCloud 占位符文件
      const full = path.join(dir, item)
      const stat = fs.lstatSync(full) // lstat 不触发 iCloud 下载
      if (stat.isDirectory()) results = results.concat(getAllFiles(full, ext))
      else if (!ext || full.endsWith(ext)) results.push(full)
    }
  } catch (_) {}
  return results
}

function getFolders(dir, rootPath) {
  let results = [{ label: '（根目录）', value: rootPath }]
  try {
    for (const item of fs.readdirSync(dir)) {
      if (item.startsWith('.')) continue
      if (item.endsWith('.icloud')) continue
      const full = path.join(dir, item)
      if (fs.lstatSync(full).isDirectory()) {
        results.push({ label: path.relative(rootPath, full), value: full })
        results = results.concat(getFolders(full, rootPath).slice(1))
      }
    }
  } catch (_) {}
  return results
}

function scanDirectory(dir) {
  let mdCount = 0, pdfCount = 0, imgCount = 0, videoCount = 0, otherCount = 0
  const recentFiles = []
  function walk(d) {
    try {
      for (const item of fs.readdirSync(d)) {
        if (item.startsWith('.')) continue
        if (item.endsWith('.icloud')) continue
        const full = path.join(d, item)
        const stat = fs.lstatSync(full)
        if (stat.isDirectory()) { walk(full) } else {
          const ext = path.extname(item).toLowerCase()
          if (ext === '.md') mdCount++
          else if (ext === '.pdf') pdfCount++
          else if (['.png','.jpg','.jpeg','.gif','.webp'].includes(ext)) imgCount++
          else if (['.mp4','.mov','.avi','.mkv','.webm','.m4v'].includes(ext)) videoCount++
          else otherCount++
          recentFiles.push({ name: item, path: full, mtime: stat.mtime })
        }
      }
    } catch (_) {}
  }
  walk(dir)
  recentFiles.sort((a, b) => b.mtime - a.mtime)
  const recent = recentFiles.slice(0, 10).map(f => ({ name: f.name, path: f.path, relativePath: path.relative(dir, f.path), mtime: f.mtime.toISOString().slice(0, 10) }))
  return { mdCount, pdfCount, imgCount, videoCount, otherCount, recent, folderTree: buildTree(dir) }
}

function buildTree(dir, depth) {
  depth = depth || 0
  const name = depth === 0 ? path.basename(dir) + ' （根目录）' : path.basename(dir)
  const node = { name, path: dir, children: [] }
  try {
    for (const item of fs.readdirSync(dir)) {
      if (item.startsWith('.')) continue
      if (item.endsWith('.icloud')) continue
      const full = path.join(dir, item)
      if (fs.lstatSync(full).isDirectory()) node.children.push(buildTree(full, depth + 1))
    }
  } catch (_) {}
  return node
}

// ── AI 分析文件夹（Map-Reduce：逐篇提取摘要 → 汇总生成报告）──
ipcMain.handle('ai-analyze-folder', async (event, { filePaths, userPrompt }) => {
  const settings = store.get('aiSettings', {})
  if (!settings.apiKey || !settings.modelId) {
    return { success: false, error: '请先在系统设置中配置 API Key 和模型 ID' }
  }
  const allFiles = (filePaths || []).filter(p => p.endsWith('.md') || p.endsWith('.pdf'))
  if (!allFiles.length) { return { success: false, error: '没有选择任何文件' } }

  // ── 读取每个文件的正文 ──
  async function readFileBody(filePath) {
    const ext = path.extname(filePath).toLowerCase()
    if (ext === '.pdf') {
      const pdfBuffer = fs.readFileSync(filePath)
      const pdfData = await pdfParse(pdfBuffer)
      return (pdfData.text || '').trim()
    } else {
      const raw = fs.readFileSync(filePath, 'utf-8')
      return raw.replace(/^---[\s\S]*?---\n?/, '').trim()
    }
  }

  // ── 单文件模式：直接把全文送给 AI，不做 Map 摘要 ──
  // 内容超过 3000 字时自动分段处理，每段独立调用 AI，最后拼合结果
  if (allFiles.length === 1) {
    const filePath = allFiles[0]
    const ext = path.extname(filePath).toLowerCase()
    const fileName = path.basename(filePath, ext)
    event.sender.send('ai-analyze-progress', { current: 1, total: 1, fileName })
    try {
      const body = await readFileBody(filePath)
      if (!body) {
        const reason = ext === '.pdf' ? 'PDF 为扫描图片版，无法提取文字' : '文件内容为空'
        return { success: false, error: reason }
      }

      const CHUNK_SIZE = 3000
      const chunks = []
      for (let i = 0; i < body.length; i += CHUNK_SIZE) {
        chunks.push(body.slice(i, i + CHUNK_SIZE))
      }

      const results = []
      for (let i = 0; i < chunks.length; i++) {
        const chunkLabel = chunks.length > 1 ? `（第 ${i+1}/${chunks.length} 段）` : ''
        event.sender.send('ai-analyze-progress', {
          current: 1, total: 1,
          fileName: chunks.length > 1 ? `正在处理第 ${i+1}/${chunks.length} 段...` : '正在生成报告...',
          reducing: true
        })
        const chunkPrompt = chunks.length > 1
          ? `你是一个知识管理助手。以下是文件「${fileName}」的第 ${i+1}/${chunks.length} 段内容：\n\n${chunks[i]}\n\n---\n用户需求：${userPrompt}\n\n请根据用户需求处理这段内容${chunkLabel}。用中文回答，使用 Markdown 格式。`
          : `你是一个知识管理助手。以下是文件「${fileName}」的完整内容：\n\n${chunks[i]}\n\n---\n用户需求：${userPrompt}\n\n请根据用户需求处理以上内容。用中文回答，使用 Markdown 格式。`
        const replyObj = await callVolcanoAI(settings.apiKey, settings.modelId, settings.endpoint, [{ role: 'user', content: chunkPrompt }], 6000)
        recordTokenUsage('analyze', 'text', replyObj.usage.prompt_tokens||0, replyObj.usage.completion_tokens||0)
        results.push(replyObj.content)
      }

      const finalResult = chunks.length > 1
        ? results.map((r, i) => `## 第 ${i+1} 段\n\n${r}`).join('\n\n---\n\n')
        : results[0]

      return { success: true, result: finalResult, fileCount: 1 }
    } catch (err) {
      return { success: false, error: '处理失败：' + err.message }
    }
  }

  // ── 多文件模式：Map-Reduce ──
  const summaries = []
  for (let i = 0; i < allFiles.length; i++) {
    const filePath = allFiles[i]
    const ext = path.extname(filePath).toLowerCase()
    const fileName = path.basename(filePath, ext)
    event.sender.send('ai-analyze-progress', { current: i + 1, total: allFiles.length, fileName })
    try {
      const body = await readFileBody(filePath)
      if (!body) {
        const reason = ext === '.pdf' ? '（PDF 为扫描图片版，无法提取文字）' : '（文件内容为空）'
        summaries.push({ fileName, title: fileName, summary: reason, keywords: [], keyPoints: [] })
        continue
      }
      const bodyTrunc = body.slice(0, 2000)
      const mapPrompt = '请阅读以下内容，提取关键信息，只输出 JSON，格式严格如下，不要加任何其他文字或代码块标记：\n{"title":"标题或核心主题（15字内）","keywords":["关键词1","关键词2"],"summary":"核心内容一句话概括（60字内）","keyPoints":["要点1","要点2"]}\n\n文件名：' + fileName + '\n内容：\n' + bodyTrunc
      const replyObj4 = await callVolcanoAI(settings.apiKey, settings.modelId, settings.endpoint, [{ role: 'user', content: mapPrompt }])
      recordTokenUsage('analyze', 'text', replyObj4.usage.prompt_tokens||0, replyObj4.usage.completion_tokens||0)
      const raw4 = (replyObj4.content || '').trim()
      const jsonMatch = raw4.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error('模型未返回JSON：' + raw4.slice(0, 100))
      const parsed = JSON.parse(jsonMatch[0])
      summaries.push({ fileName, title: parsed.title || fileName, keywords: parsed.keywords || [], summary: parsed.summary || '', keyPoints: parsed.keyPoints || [] })
    } catch (err) {
      summaries.push({ fileName, title: fileName, summary: '（解析失败：' + err.message.slice(0, 80) + '）', keywords: [], keyPoints: [] })
    }
  }
  event.sender.send('ai-analyze-progress', { current: allFiles.length, total: allFiles.length, fileName: '正在生成报告...', reducing: true })
  const summaryText = summaries.map((s, i) =>
    '【' + (i+1) + '】' + (s.title || s.fileName) + '\n关键词：' + ((s.keywords || []).join('、') || '无') + '\n摘要：' + s.summary + '\n要点：' + ((s.keyPoints || []).join('；') || '无')
  ).join('\n\n')
  const reducePrompt = '你是一个知识管理助手。以下是用户选择的 ' + summaries.length + ' 篇笔记的摘要信息。\n\n' + summaryText + '\n\n---\n用户需求：' + userPrompt + '\n\n请根据用户需求，基于以上所有笔记内容，生成相应的输出。用中文回答，使用 Markdown 格式。'
  try {
    const replyObj5 = await callVolcanoAI(settings.apiKey, settings.modelId, settings.endpoint, [{ role: 'user', content: reducePrompt }], 4000)
    recordTokenUsage('analyze', 'text', replyObj5.usage.prompt_tokens||0, replyObj5.usage.completion_tokens||0)
    return { success: true, result: replyObj5.content, fileCount: allFiles.length }
  } catch (err) { return { success: false, error: '生成报告失败：' + err.message } }
})

// ── AI 音频/视频转笔记 ──
ipcMain.handle('select-audio-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: '选择音频或视频文件',
    filters: [
      { name: '音频/视频文件', extensions: ['mp3','mp4','m4a','wav','ogg','mov','avi','mkv','aac','flac','wma','webm'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  })
  if (!result.canceled && result.filePaths.length > 0) {
    const fp = result.filePaths[0]
    const stat = fs.statSync(fp)
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1)
    return { success: true, path: fp, name: path.basename(fp), sizeMB }
  }
  return { success: false }
})

ipcMain.handle('ai-audio-to-note', async (event, { filePath, customPrompt }) => {
  const settings = store.get('aiSettings', {})
  const audioApiKey = settings.audioApiKey || settings.apiKey || ''
  if (!audioApiKey) return { success: false, error: '请先在系统设置中配置音视频模型的 API Key' }
  const audioModelId = settings.audioModelId || ''
  if (!audioModelId) return { success: false, error: '请先在系统设置中配置「音视频模型 ID」（如 doubao-seed-2.0-lite 的接入点 ID）' }
  const endpoint = settings.audioEndpoint || settings.endpoint || 'https://ark.cn-beijing.volces.com/api/v3'

  try {
    // Step 1: 上传文件到 Files API
    event.sender.send('audio-note-progress', { step: 'upload', msg: '正在上传文件（可能需要几十秒）...' })
    const fileId = await uploadFileToArk(audioApiKey, endpoint, filePath)
    event.sender.send('audio-note-progress', { step: 'upload', msg: '文件上传成功，等待处理完毕...' })
    await waitFileActive(audioApiKey, endpoint, fileId)

    // Step 2: 调用多模态模型转录+理解
    event.sender.send('audio-note-progress', { step: 'transcribe', msg: '正在识别语音内容...' })
    const fileName = path.basename(filePath)
    const transcribePrompt = '请完整转录这个音频/视频文件中的所有语音内容，输出完整的转录文本，不要遗漏任何内容，保持自然段落分隔。只输出转录文本，不要加任何说明。'
    const transcriptResult = await callArkMultimodal(audioApiKey, audioModelId, endpoint, fileId, transcribePrompt, filePath)
    const transcriptRaw = transcriptResult.content
    recordTokenUsage('audio', 'audio', transcriptResult.usage.prompt_tokens||0, transcriptResult.usage.completion_tokens||0)

    // 如果是空或者错误信息，直接返回原始内容方便调试
    if (!transcriptRaw) {
      return { success: false, error: '模型返回了空响应，请确认音频模型ID是否正确，文件是否有语音内容' }
    }
    const transcript = transcriptRaw.trim()
    if (transcript.length < 5) {
      return { success: false, error: '转录结果过短（' + transcript.length + '字），原始响应：' + JSON.stringify(transcriptRaw) }
    }

    // Step 3: 用 DeepSeek 整理成结构化笔记
    event.sender.send('audio-note-progress', { step: 'organize', msg: '正在生成结构化笔记...' })
    const noteModelId = settings.modelId || audioModelId
    const noteEndpoint = endpoint
    // 判断转录内容语言
    const transcriptChineseChars = (transcript.match(/[\u4e00-\u9fff]/g) || []).length
    const audioIsChinese = transcriptChineseChars / transcript.length > 0.1
    const audioLangInstruction = audioIsChinese
      ? '转录内容为中文，请直接用中文整理笔记。'
      : '转录内容为非中文，请将笔记整理为中文。笔记末尾用「---」分隔，标题为「原始转录文本」，附上完整转录内容。'

    const basePrompt = customPrompt && customPrompt.trim()
      ? customPrompt.trim()
      : '请整理成结构化笔记，包含：核心主题、主要内容摘要、关键要点列表。'
    const organizePrompt = '以下是一段音频/视频（文件名：' + fileName + '）的完整转录内容：\n\n' + transcript + '\n\n语言要求：' + audioLangInstruction + '\n\n请根据以下要求生成笔记：\n' + basePrompt + (audioIsChinese ? '\n\n请用 Markdown 格式输出，笔记结构如下：\n1. 上半部分：AI 整理的结构化笔记\n2. 下半部分：用 --- 分隔，标题为「原始转录文本」，附上完整转录内容。' : '')
    const replyObj6 = await callVolcanoAI(settings.apiKey, noteModelId, noteEndpoint, [{ role: 'user', content: organizePrompt }], 4000)
    recordTokenUsage('audio', 'text', replyObj6.usage.prompt_tokens||0, replyObj6.usage.completion_tokens||0)

    event.sender.send('audio-note-progress', { step: 'done', msg: '完成！' })
    return { success: true, result: replyObj6.content, transcript, fileName }
  } catch (err) {
    return { success: false, error: '处理失败：' + err.message }
  }
})

// 等待文件状态变为 active（上传后服务端需要处理）
function waitFileActive(apiKey, endpoint, fileId) {
  return new Promise((resolve, reject) => {
    let attempts = 0
    const maxAttempts = 30  // 最多等 60 秒
    function check() {
      attempts++
      if (attempts > maxAttempts) { reject(new Error('文件处理超时，请重试')); return }
      const url = new URL(endpoint + '/files/' + fileId)
      const options = {
        hostname: url.hostname, path: url.pathname, method: 'GET',
        headers: { 'Authorization': 'Bearer ' + apiKey }
      }
      const req = https.request(options, res => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            if (json.status === 'active') { resolve(); return }
            if (json.status === 'error') { reject(new Error('文件处理失败：' + JSON.stringify(json))); return }
            // 还在处理中，等 2 秒再试
            setTimeout(check, 2000)
          } catch (e) { reject(e) }
        })
      })
      req.on('error', reject)
      req.end()
    }
    // 先等 1 秒再开始轮询
    setTimeout(check, 1000)
  })
}

// 上传文件到火山方舟 Files API，返回 file_id
function uploadFileToArk(apiKey, endpoint, filePath) {
  return new Promise((resolve, reject) => {
    const fileBuffer = fs.readFileSync(filePath)
    const fileName = path.basename(filePath)
    const boundary = '----ArkBoundary' + Date.now().toString(16)
    const CRLF = '\r\n'
    // 正确的 multipart 结构：purpose 字段 + file 字段
    const part1 = Buffer.from(
      '--' + boundary + CRLF +
      'Content-Disposition: form-data; name="purpose"' + CRLF + CRLF +
      'user_data' + CRLF
    )
    const part2Header = Buffer.from(
      '--' + boundary + CRLF +
      'Content-Disposition: form-data; name="file"; filename="' + fileName + '"' + CRLF +
      'Content-Type: application/octet-stream' + CRLF + CRLF
    )
    const part2Footer = Buffer.from(CRLF + '--' + boundary + '--' + CRLF)
    const fullBody = Buffer.concat([part1, part2Header, fileBuffer, part2Footer])
    const url = new URL(endpoint + '/files')
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': fullBody.length
      }
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          if (json.id) resolve(json.id)
          else reject(new Error('上传失败：' + JSON.stringify(json)))
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(fullBody)
    req.end()
  })
}

// 调用多模态模型（doubao-seed）处理音频/视频文件
// 官方文档：音频用 input_audio + file_id，视频用 video_url + file_id
function callArkMultimodal(apiKey, modelId, endpoint, fileId, prompt, filePath) {
  const ext = path.extname(filePath).toLowerCase().slice(1)
  const videoExts = ['mp4','mov','avi','mkv','webm']
  const isVideo = videoExts.includes(ext)

  return new Promise((resolve, reject) => {
    let mediaContent
    if (isVideo) {
      mediaContent = { type: 'video_url', video_url: { file_id: fileId } }
    } else {
      mediaContent = { type: 'input_audio', input_audio: { file_id: fileId } }
    }
    const messages = [{
      role: 'user',
      content: [
        mediaContent,
        { type: 'text', text: prompt }
      ]
    }]
    const body = JSON.stringify({ model: modelId, messages, max_tokens: 8000 })
    const url = new URL(endpoint + '/chat/completions')
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(body)
      }
    }
    const req = require('https').request(options, res => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          if (json.error) { reject(new Error('API错误: ' + JSON.stringify(json.error))); return }
          const content = json.choices?.[0]?.message?.content
          resolve({ content: content !== undefined ? content : null, usage: json.usage || {} })
        } catch (e) { reject(new Error('解析响应失败: ' + data.slice(0, 200))) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ── Doubao 视觉模型：用 base64 图片理解图片内容 ──
// 复用音视频的 apiKey / endpoint / modelId，不需要额外上传文件
function callDoubaoVision(apiKey, modelId, endpoint, imagePath, prompt) {
  return new Promise((resolve, reject) => {
    try {
      const ext = path.extname(imagePath).toLowerCase().slice(1)
      const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }
      const mimeType = mimeMap[ext] || 'image/jpeg'
      const imageData = fs.readFileSync(imagePath)
      const base64 = imageData.toString('base64')
      const messages = [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: 'text', text: prompt }
        ]
      }]
      const body = JSON.stringify({ model: modelId, messages, max_tokens: 500 })
      const url = new URL(endpoint + '/chat/completions')
      const options = {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
          'Content-Length': Buffer.byteLength(body)
        }
      }
      const req = require('https').request(options, res => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            if (json.error) { reject(new Error('视觉API错误: ' + JSON.stringify(json.error))); return }
            const content = json.choices?.[0]?.message?.content || ''
            resolve({ content, usage: json.usage || {} })
          } catch (e) { reject(new Error('解析视觉响应失败: ' + data.slice(0, 200))) }
        })
      })
      req.on('error', reject)
      req.write(body)
      req.end()
    } catch (e) { reject(e) }
  })
}

function buildAnalyzeTree(dir, rootPath, depth) {
  depth = depth || 0
  const name = depth === 0 ? path.basename(dir) + '（根目录）' : path.basename(dir)
  const node = { name, path: dir, depth, children: [], fileCount: 0 }
  try {
    for (const item of fs.readdirSync(dir)) {
      if (item.startsWith('.')) continue
      if (item.endsWith('.icloud')) continue
      const full = path.join(dir, item)
      const stat = fs.lstatSync(full)
      if (stat.isDirectory()) {
        node.children.push(buildAnalyzeTree(full, rootPath, depth + 1))
      } else {
        node.fileCount++
      }
    }
  } catch (_) {}
  return node
}

// ── 选择 YouTube Cookies 文件 ──
ipcMain.handle('select-cookies-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 YouTube Cookies 文件',
    filters: [{ name: 'Cookies 文件', extensions: ['txt'] }, { name: '所有文件', extensions: ['*'] }],
    properties: ['openFile']
  })
  if (!result.canceled && result.filePaths.length > 0) {
    return { success: true, path: result.filePaths[0] }
  }
  return { success: false }
})

// ── YouTube 字幕抓取（基于 yt-dlp）──
const { execFile, execSync } = require('child_process')
const os = require('os')
const isWin = process.platform === 'win32'

// ── PDF 文字提取（使用 pdf-parse，纯 Node.js，无需外部工具）──
async function extractPdfText(filePath, maxChars) {
  try {
    const pdfParse = require('pdf-parse')
    const buffer = fs.readFileSync(filePath)
    const data = await pdfParse(buffer)
    return (data.text || '').slice(0, maxChars || 1500).trim()
  } catch (_) {
    return ''
  }
}

function getYtDlpPath() {
  // 优先用项目目录下的 yt-dlp（Windows 用 .exe，Mac/Linux 不带后缀）
  const localName = isWin ? 'yt-dlp.exe' : 'yt-dlp'
  const localPath = path.join(__dirname, '..', localName)
  if (fs.existsSync(localPath)) return localPath
  // 再找系统 PATH
  try {
    const whichCmd = isWin ? 'where yt-dlp' : 'which yt-dlp'
    const found = execSync(whichCmd, { timeout: 3000 }).toString().trim().split('\n')[0].trim()
    if (found) return found
  } catch (_) {}
  return null
}

async function ensureYtDlp(sendProgress) {
  const existing = getYtDlpPath()
  if (existing) return existing

  // 自动下载 yt-dlp 到项目目录（按平台选择文件）
  sendProgress('首次使用：正在自动安装 yt-dlp（约 10MB，只需一次）...')
  const ytDlpFileName = isWin ? 'yt-dlp.exe' : 'yt-dlp'
  const destPath = path.join(__dirname, '..', ytDlpFileName)
  const ytDlpDownloadUrl = isWin
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos'
  return new Promise((resolve, reject) => {
    const https = require('https')
    const url = ytDlpDownloadUrl
    const followRedirect = (urlStr) => {
      const u = new URL(urlStr)
      const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          followRedirect(res.headers.location); return
        }
        const file = fs.createWriteStream(destPath)
        res.pipe(file)
        file.on('finish', () => {
          file.close()
          // Mac/Linux 需要添加执行权限
          if (!isWin) { try { fs.chmodSync(destPath, 0o755) } catch (_) {} }
          resolve(destPath)
        })
        file.on('error', reject)
      })
      req.on('error', reject)
      req.setTimeout(60000, () => { req.destroy(); reject(new Error('下载超时')) })
      req.end()
    }
    followRedirect(url)
  })
}

function runYtDlp(ytDlpPath, args) {
  // 自动注入 --js-runtimes node
  let fullArgs = ['--js-runtimes', 'node'].concat(args)
  // 自动注入 cookies 文件（如果已配置）
  const settings = store.get('aiSettings', {})
  const cookiesFile = settings.ytCookiesFile || ''
  if (cookiesFile && require('fs').existsSync(cookiesFile)) {
    fullArgs = ['--cookies', cookiesFile].concat(fullArgs)
  }
  return new Promise((resolve, reject) => {
    execFile(ytDlpPath, fullArgs, { timeout: 120000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) { reject(new Error(stderr || err.message)); return }
      resolve(stdout || '')
    })
  })
}

ipcMain.handle('youtube-to-note', async (event, { videoUrl, userPrompt }) => {
  const settings = store.get('aiSettings', {})
  if (!settings.apiKey || !settings.modelId) {
    return { success: false, error: '请先在系统设置中配置 API Key 和模型 ID' }
  }

  const sendProgress = (msg) => {
    try { event.sender.send('youtube-note-progress', msg) } catch (_) {}
  }

  let tmpDir = null
  try {
    // 1. 规范化 URL
    let cleanUrl = videoUrl.trim()
    if (!cleanUrl.startsWith('http')) cleanUrl = 'https://' + cleanUrl
    if (cleanUrl.includes('youtu.be/')) {
      const vid = cleanUrl.split('youtu.be/')[1].split('?')[0]
      cleanUrl = 'https://www.youtube.com/watch?v=' + vid
    }

    // 2. 确保 yt-dlp 可用
    const ytDlpPath = await ensureYtDlp(sendProgress)
    sendProgress('正在获取视频信息...')

    // 3. 获取视频信息
    const infoJson = await runYtDlp(ytDlpPath, [
      '--extractor-args', 'youtube:player_client=android',
      '--dump-json', '--no-playlist', '--no-warnings', cleanUrl
    ])
    const info = JSON.parse(infoJson)
    const videoTitle = info.title || '未知标题'
    const author = info.uploader || info.channel || '未知作者'
    const lengthSeconds = info.duration || 0
    const duration = Math.floor(lengthSeconds / 60) + '分钟' + (lengthSeconds % 60) + '秒'

    sendProgress('已获取视频：' + videoTitle)

    // 4. 临时目录
    tmpDir = path.join(os.tmpdir(), 'yt-captions-' + Date.now())
    fs.mkdirSync(tmpDir, { recursive: true })

    // 5. 尝试下载软字幕
    sendProgress('正在尝试获取字幕轨道...')
    let rawText = ''
    let captionLang = ''
    let usedVision = false

    try {
      await runYtDlp(ytDlpPath, [
        '--extractor-args', 'youtube:player_client=android',
        '--write-subs', '--write-auto-subs',
        '--sub-langs', 'zh-Hans,zh-Hant,zh,en,en-US,en-GB',
        '--sub-format', 'vtt', '--skip-download',
        '--no-playlist', '--no-warnings',
        '-o', path.join(tmpDir, 'caption'), cleanUrl
      ])
    } catch (_) {}

    const vttFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.vtt'))

    if (vttFiles.length > 0) {
      // ─── 路径A：有软字幕 ───
      const zhFile = vttFiles.find(f => f.includes('.zh') || f.includes('zh-Hans') || f.includes('zh-Hant'))
      const enFile = vttFiles.find(f => f.includes('.en'))
      const selectedFile = zhFile || enFile || vttFiles[0]
      captionLang = zhFile ? 'zh' : (enFile ? 'en' : 'other')
      const vttContent = fs.readFileSync(path.join(tmpDir, selectedFile), 'utf-8')
      rawText = parseVttCaption(vttContent)
      sendProgress('已获取字幕轨道，AI 整理中...')

    } else {
      // ─── 路径B：无软字幕，用 AI 视觉识别硬字幕 ───
      if (!settings.audioModelId) {
        return {
          success: false,
          error: '该视频使用的是硬字幕（烧录在画面里），需要 AI 视觉识别。\n\n请在「系统设置」中配置「音频模型 ID」（Doubao-Seed 全模态模型接入点），程序即可自动识别画面中的字幕。'
        }
      }

      sendProgress('未找到字幕轨道（硬字幕），正在下载视频片段...')

      // 下载最低画质视频（前5分钟）
      const videoPath = path.join(tmpDir, 'video.mp4')
      const maxSec = Math.min(lengthSeconds, 300)
      const endTime = Math.floor(maxSec / 60) + ':' + String(maxSec % 60).padStart(2, '0')

      // 使用 android 客户端下载（绕过 YouTube 403 限制），最低画质
      try {
        await runYtDlp(ytDlpPath, [
          '--extractor-args', 'youtube:player_client=android',
          '--format', 'worst',
          '--no-playlist', '--no-warnings',
          '-o', videoPath, cleanUrl
        ])
      } catch (e) {
        return { success: false, error: '视频下载失败：' + e.message }
      }

      if (!fs.existsSync(videoPath)) {
        return { success: false, error: '视频下载失败，请检查网络连接' }
      }

      const videoMB = (fs.statSync(videoPath).size / 1024 / 1024).toFixed(1)
      sendProgress('视频已下载（' + videoMB + 'MB），上传至 AI 识别字幕...')

      // 上传到火山方舟 Files API
      const uploadedFileId = await uploadFileToArk(
        settings.apiKey, settings.endpoint, videoPath
      )

      // 等待文件处理完毕（status 变为 active），否则调用模型会报 InvalidState
      sendProgress('文件上传成功，等待服务器处理...')
      await waitFileActive(settings.apiKey, settings.endpoint, uploadedFileId)

      sendProgress('AI 视觉识别中，请稍候（约1~2分钟）...')

      // 调 Doubao 全模态模型逐帧识别字幕
      const visionReply = await callArkMultimodal(
        settings.apiKey, settings.audioModelId, settings.endpoint,
        uploadedFileId,
        '请完整提取这段视频中出现的所有字幕文字，按出现顺序排列。要求：1. 只输出字幕的文字内容，不要输出时间戳、序号或任何格式标记；2. 每条字幕单独一行；3. 如果没有字幕，请描述视频的主要内容。',
        videoPath
      )

      rawText = visionReply.content || ''
      recordTokenUsage('youtube', 'audio', visionReply.usage.prompt_tokens||0, visionReply.usage.completion_tokens||0)
      captionLang = 'zh'
      usedVision = true
      sendProgress('字幕识别完成，AI 整理笔记中...')
    }

    if (!rawText || rawText.length < 10) {
      return { success: false, error: '未能获取到字幕内容，无法生成笔记' }
    }

    // 6. 调 DeepSeek 整理笔记
    const isChinese = captionLang === 'zh' || usedVision
    const notePrompt = (userPrompt && userPrompt.trim()) ? userPrompt.trim() : '请整理成结构清晰的笔记，包含：核心主题、主要观点、重要细节、总结'
    const sourceNote = usedVision ? '（以下内容由 AI 视觉识别视频画面字幕获得）' : ''
    const langInstruction = isChinese
      ? '原文为中文，请直接用中文整理笔记。'
      : '原文为非中文内容，请将笔记整理为中文，笔记末尾用「---」分隔后附上原文字幕内容。'

    const userMsg = '以下是 YouTube 视频的字幕内容' + sourceNote + '，请帮我整理成笔记。\n\n视频信息：\n- 标题：' + videoTitle + '\n- 作者：' + author + '\n- 时长：' + duration + '\n\n语言要求：' + langInstruction + '\n\n笔记要求：' + notePrompt + '\n\n字幕内容（前8000字）：\n' + rawText.slice(0, 8000)

    const replyObj7 = await callVolcanoAI(
      settings.apiKey, settings.modelId, settings.endpoint,
      [
        { role: 'system', content: '你是一个专业的笔记整理助手，擅长从视频字幕中提炼有价值的内容，输出结构清晰的 Markdown 笔记。若原文非中文，笔记主体必须为中文，并在末尾附上原文。' },
        { role: 'user', content: userMsg }
      ],
      4000
    )
    recordTokenUsage('youtube', 'text', replyObj7.usage.prompt_tokens||0, replyObj7.usage.completion_tokens||0)

    sendProgress('完成！')
    return {
      success: true,
      note: replyObj7.content,
      videoTitle,
      author,
      duration,
      captionLang: usedVision ? 'AI视觉识别' : captionLang,
      rawCaption: rawText,
      usedVision
    }

  } catch (err) {
    return { success: false, error: err.message }
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
    }
  }
})

function parseVttCaption(vtt) {
  const lines = vtt.split('\n')
  const textLines = []
  const seen = new Set()

  for (const line of lines) {
    const t = line.trim()
    // 跳过空行、头部、纯数字序号、任何包含时间戳箭头的行
    if (!t) continue
    if (t === 'WEBVTT' || t.startsWith('Kind:') || t.startsWith('Language:')) continue
    if (/-->/.test(t)) continue
    if (/^\d+$/.test(t)) continue
    if (t.startsWith('NOTE') || t.startsWith('STYLE') || t.startsWith('REGION')) continue
    // 去掉 VTT 内联标签 <00:00:00.000> <c> </c> 等
    const clean = t
      .replace(/<\d{2}:\d{2}:\d{2}\.\d+>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .trim()
    if (clean && !seen.has(clean)) {
      seen.add(clean)
      textLines.push(clean)
    }
  }
  return textLines.join(' ')
}


// ── 网页内容转笔记 ──
function fetchWebPage(pageUrl) {
  return new Promise((resolve, reject) => {
    const https = require('https')
    const http = require('http')
    const url = new URL(pageUrl)
    const lib = url.protocol === 'https:' ? https : http
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity'
      }
    }
    const req = lib.request(options, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : url.origin + res.headers.location
        fetchWebPage(redirectUrl).then(resolve).catch(reject)
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error('HTTP ' + res.statusCode))
        return
      }
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    })
    req.on('error', reject)
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时')) })
    req.end()
  })
}

ipcMain.handle('webpage-to-note', async (event, { pageUrl, userPrompt, pasteContent, pasteTitle }) => {
  const settings = store.get('aiSettings', {})
  if (!settings.apiKey || !settings.modelId) {
    return { success: false, error: '请先在系统设置中配置 API Key 和模型 ID' }
  }
  const sendProgress = (msg) => {
    try { event.sender.send('webpage-note-progress', msg) } catch (_) {}
  }
  try {
    let title = '', rawText = '', cleanUrl = pageUrl ? pageUrl.trim() : ''

    if (pasteContent && pasteContent.trim()) {
      // ── 粘贴模式：直接用用户粘贴的内容 ──
      sendProgress('正在整理粘贴的内容...')
      rawText = pasteContent.trim()
      title = pasteTitle || '粘贴内容'
      if (!cleanUrl) cleanUrl = ''

    } else {
      // ── 链接模式：抓取网页 ──
      if (!cleanUrl.startsWith('http')) cleanUrl = 'https://' + cleanUrl
      sendProgress('正在获取网页内容...')
      const html = await fetchWebPage(cleanUrl)
      if (!html || html.length < 100) {
        return { success: false, error: '无法获取网页内容，请检查链接是否正确或改用「粘贴模式」' }
      }

      sendProgress('正在提取正文...')
      const { JSDOM } = require('jsdom')
      const { Readability } = require('@mozilla/readability')
      const dom = new JSDOM(html, { url: cleanUrl })
      const reader = new Readability(dom.window.document)
      const article = reader.parse()

      if (article && article.textContent && article.textContent.trim().length > 100) {
        title = article.title || ''
        rawText = article.textContent.trim()
      } else {
        title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''
        title = title.replace(/<[^>]+>/g, '').trim()
        rawText = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s{2,}/g, '\n')
          .trim()
          .slice(0, 15000)
      }

      if (!rawText || rawText.length < 50) {
        return { success: false, error: '网页内容为空或无法解析，请改用「粘贴模式」手动粘贴正文' }
      }
    }

    // 3. 判断原文语言
    const chineseChars = (rawText.match(/[\u4e00-\u9fff]/g) || []).length
    const webIsChinese = chineseChars / rawText.length > 0.1
    const webLangInstruction = webIsChinese
      ? '原文为中文，请直接用中文整理笔记。'
      : '原文为非中文内容，请将笔记整理为中文，笔记末尾用「---」分隔后附上原文原始内容（前3000字）。'

    // 4. 调 DeepSeek 整理笔记
    sendProgress('AI 正在整理笔记...')
    const notePrompt = (userPrompt && userPrompt.trim())
      ? userPrompt.trim()
      : '请整理成结构清晰的笔记，包含：文章主题、核心观点、重要细节、总结'

    const userMsg = `以下是网页「${title}」的正文内容，请帮我整理成笔记。

网页链接：${cleanUrl}
语言要求：${webLangInstruction}
笔记要求：${notePrompt}

正文内容（前10000字）：
${rawText.slice(0, 10000)}`

    const replyObj8 = await callVolcanoAI(
      settings.apiKey, settings.modelId, settings.endpoint,
      [
        { role: 'system', content: '你是一个专业的笔记整理助手，擅长从网页文章中提炼有价值的内容，输出结构清晰的 Markdown 笔记。若原文非中文，笔记主体必须为中文，并在末尾附上原文。' },
        { role: 'user', content: userMsg }
      ],
      4000
    )
    recordTokenUsage('webpage', 'text', replyObj8.usage.prompt_tokens||0, replyObj8.usage.completion_tokens||0)

    sendProgress('完成！')
    return {
      success: true,
      note: replyObj8.content,
      title: title || cleanUrl,
      rawText: rawText,
      url: cleanUrl
    }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ── AI 智能保存笔记（识别内容、匹配文件夹、生成文件名和标签）──
ipcMain.handle('ai-smart-save-note', async (event, { content, vaultPath, vaultFolders, inboxFolder, inboxPath, sourceType, sourceTitle }) => {
  const settings = store.get('aiSettings', {})
  if (!settings.apiKey || !settings.modelId) {
    return { success: false, error: '请先在系统设置中配置 API Key 和模型 ID' }
  }

  // 构建文件夹列表供 AI 选择
  const folderList = (vaultFolders || [])
    .map(f => f.label)
    .filter(l => l && l !== '（根目录）')
    .join('、')

  // 取内容摘要（前3000字供 AI 判断）
  const contentSnippet = (content || '').slice(0, 3000)

  const prompt = `你是一个知识库笔记整理助手。
知识库现有文件夹：${folderList || '（暂无文件夹）'}
笔记来源类型：${sourceType || '未知'}
笔记原始标题：${sourceTitle || '未知'}

请根据以下笔记内容，判断并输出：
1. filename：适合的文件名（不含扩展名，不超过40字，不能含 \\ / : * ? " < > | 等特殊字符）
   文件名语言规则：
   - 若原文内容主要为中文 → 文件名用中文
   - 若原文内容主要为英文 → 文件名可用英文
   - 若原文内容为其他语言（如泰文、日文、韩文等）→ 文件名必须翻译为中文
2. tags：适合的标签（用英文逗号分隔，中文，2~4个）
3. folder：最匹配的文件夹相对路径（必须从上面「知识库现有文件夹」列表中选择，如果没有合适的文件夹则输出空字符串 ""）

笔记内容（前3000字）：
${contentSnippet}

请严格按以下 JSON 格式回复，不要加任何其他文字：
{"filename":"xxx","tags":"xxx,xxx","folder":"xxx"}`

  let aiResult = null
  try {
    const replyObj9 = await callVolcanoAI(
      settings.apiKey, settings.modelId, settings.endpoint,
      [{ role: 'user', content: prompt }],
      500
    )
    recordTokenUsage('save', 'text', replyObj9.usage.prompt_tokens||0, replyObj9.usage.completion_tokens||0)
    const clean = (replyObj9.content||'').replace(/```json|```/g, '').trim()
    aiResult = JSON.parse(clean)
  } catch (err) {
    // AI 失败则用兜底逻辑
    aiResult = { filename: '', tags: '', folder: '' }
  }

  const filename = (aiResult.filename || '').replace(/[\\/:*?"<>|]/g, '_').trim() ||
    (sourceTitle || '未命名笔记').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)
  const tags = aiResult.tags || ''
  const aiFolder = (aiResult.folder || '').trim()

  // 确定目标文件夹
  let targetDir = null
  let usedInbox = false
  let noMatch = false

  if (aiFolder) {
    // AI 给出了文件夹，找到对应的绝对路径
    const matched = (vaultFolders || []).find(f =>
      f.label && f.label.replace(/\\/g, '/') === aiFolder.replace(/\\/g, '/')
    )
    if (matched && matched.value) {
      targetDir = matched.value
    }
  }

  if (!targetDir) {
    // 没有匹配文件夹，存临时文件夹
    noMatch = true
    if (inboxFolder) {
      targetDir = inboxFolder
      usedInbox = true
    } else if (inboxPath) {
      targetDir = inboxPath
      usedInbox = true
    } else {
      return { success: false, error: '没有匹配的文件夹，且未设置临时文件夹和待处理文件库，请先在系统设置中配置。' }
    }
  }

  // 确保目标文件夹存在
  try {
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true })
  } catch (e) {
    return { success: false, error: '目标文件夹创建失败：' + e.message }
  }

  // 生成带 frontmatter 的完整笔记内容
  const now = new Date()
  const dateStr = now.toISOString().slice(0, 10)
  const tagArr = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : []
  const tagYaml = tagArr.length ? '[' + tagArr.join(', ') + ']' : '[]'
  const fullContent = `---\ntitle: "${filename}"\ndate: "${dateStr}"\ntags: ${tagYaml}\n---\n\n${content}`

  // 写入文件（如有同名则自动加序号）
  let filePath = path.join(targetDir, filename + '.md')
  if (fs.existsSync(filePath)) {
    let i = 2
    while (fs.existsSync(path.join(targetDir, `${filename}_${i}.md`))) i++
    filePath = path.join(targetDir, `${filename}_${i}.md`)
  }

  try {
    fs.writeFileSync(filePath, fullContent, 'utf-8')
  } catch (e) {
    return { success: false, error: '文件写入失败：' + e.message }
  }

  // 触发 Hub 更新
  try { updateHubFile(targetDir, vaultPath, settings) } catch (_) {}

  return {
    success: true,
    path: filePath,
    filename,
    tags,
    folder: aiFolder,
    targetDir,
    noMatch,
    usedInbox
  }
})

// ── 整理订阅内容配文（支持翻译）──
ipcMain.handle('process-feed-caption', async (event, { text, platform, sourceName, url, date, type }) => {
  const settings = store.get('aiSettings', {})
  if (!settings.apiKey || !settings.modelId) {
    return { success: false, error: '请先配置 API Key' }
  }
  try {
    const platformNames = { youtube:'YouTube', xiaohongshu:'小红书', x:'X', instagram:'Instagram', facebook:'Facebook' }
    const platformName = platformNames[platform] || platform
    const typeLabel = type === 'video' ? '视频' : type === 'image' ? '图片' : '内容'

    // 检测是否为非中文内容
    const chineseRatio = (text.match(/[\u4e00-\u9fff]/g) || []).length / text.length
    const needTranslate = chineseRatio < 0.1 && text.length > 20

    const prompt = needTranslate
      ? `以下是来自 ${platformName}「${sourceName}」发布的${typeLabel}的配文内容（发布于${date}）。

请按以下格式整理（笔记主体必须为中文）：

## 📝 内容摘要（中文）
[用中文写一段简洁的笔记摘要，概括主要内容和关键信息]

## 📌 关键信息
[重要的人名、地点、数据等，如无则省略此节]

## 🔗 来源
平台：${platformName}
账号：${sourceName}
日期：${date}
链接：${url || '无'}

---
## 原文
${text}`
      : `以下是来自 ${platformName}「${sourceName}」发布的${typeLabel}的配文内容（发布于${date}）。

请按以下格式整理成笔记：

## 📝 内容摘要
[简洁概括主要内容和关键信息]

## 📌 关键信息
[重要的人名、地点、数据等，如无则省略此节]

## 🔗 来源
平台：${platformName}
账号：${sourceName}
日期：${date}
链接：${url || '无'}

---
## 原文
${text}`

    const replyObj10 = await callVolcanoAI(
      settings.apiKey, settings.modelId, settings.endpoint,
      [{ role: 'user', content: prompt }],
      2000
    )
    recordTokenUsage('subscription', 'text', replyObj10.usage.prompt_tokens||0, replyObj10.usage.completion_tokens||0)

    return { success: true, note: replyObj10.content, isTranslated: needTranslate }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ── 打开外部 URL（用系统默认浏览器）──
ipcMain.handle('open-external-url', (event, url) => {
  if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
    shell.openExternal(url)
  }
  return { success: true }
})

// ── 订阅追踪 ──
const { BrowserWindow: SubBrowserWindow, session } = require('electron')

function getFeedStore() { return store.get('feeds', []) }
function saveFeedStore(feeds) { store.set('feeds', feeds) }

ipcMain.handle('feed-get-all', () => getFeedStore())

ipcMain.handle('feed-mark-platform-logged-in', (event, platform) => {
  const feeds = getFeedStore()
  feeds.forEach((f, i) => { if (f.platform === platform) feeds[i].loggedIn = true })
  saveFeedStore(feeds)
  return { success: true }
})

ipcMain.handle('feed-add', (event, { platform, name, url }) => {
  const feeds = getFeedStore()
  feeds.push({ platform, name, url, lastCheck: null, seenIds: [] })
  saveFeedStore(feeds)
  return { success: true }
})

ipcMain.handle('feed-delete', (event, index) => {
  const feeds = getFeedStore()
  feeds.splice(index, 1)
  saveFeedStore(feeds)
  return { success: true }
})

ipcMain.handle('feed-reset-one', (event, index) => {
  const feeds = getFeedStore()
  if (feeds[index]) {
    feeds[index].lastCheck = null
    feeds[index].seenIds = []
    saveFeedStore(feeds)
  }
  return { success: true }
})

ipcMain.handle('feed-rename', (event, { index, name }) => {
  const feeds = getFeedStore()
  if (feeds[index]) {
    feeds[index].name = name
    saveFeedStore(feeds)
  }
  return { success: true }
})

// 各平台登录检测：检查 cookies 里有没有登录凭证
async function checkPlatformLogin(platform, ses) {
  const cookies = await ses.cookies.get({})
  const cookieMap = {}
  cookies.forEach(c => { cookieMap[c.name] = c.value })

  switch (platform) {
    case 'xiaohongshu':
      return !!(cookieMap['web_session'] || cookieMap['a1'] || cookieMap['webId'])
    case 'x':
      return !!(cookieMap['auth_token'] || cookieMap['ct0'])
    case 'instagram':
      return !!(cookieMap['sessionid'] || cookieMap['ds_user_id'])
    case 'facebook':
      return !!(cookieMap['c_user'] || cookieMap['xs'])
    default:
      return false
  }
}

ipcMain.handle('feed-open-login', async (event, index) => {
  const feeds = getFeedStore()
  const feed = feeds[index]
  if (!feed) return { success: false, error: '订阅不存在' }

  const platformUrls = {
    xiaohongshu: 'https://www.xiaohongshu.com',
    x: 'https://x.com',
    instagram: 'https://www.instagram.com',
    facebook: 'https://www.facebook.com'
  }
  const loginUrl = platformUrls[feed.platform] || feed.url
  const ses = session.fromPartition('persist:feed-' + feed.platform)

  // 先检查是否已经登录
  const alreadyLoggedIn = await checkPlatformLogin(feed.platform, ses)
  if (alreadyLoggedIn) {
    return { success: true, alreadyLoggedIn: true }
  }

  return new Promise((resolve) => {
    const loginWin = new SubBrowserWindow({
      width: 520, height: 700,
      title: '登录 ' + feed.name + '（登录成功后请关闭此窗口）',
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true }
    })
    loginWin.loadURL(loginUrl)
    loginWin.setMenu(null)

    // 页面跳转时持续检测登录状态
    loginWin.webContents.on('did-navigate', async () => {
      const loggedIn = await checkPlatformLogin(feed.platform, ses)
      if (loggedIn) {
        // 登录成功，更新整个平台所有订阅的登录状态
        const feeds2 = getFeedStore()
        const plat = feeds2[index]?.platform
        feeds2.forEach((f, i) => { if (f.platform === plat) feeds2[i].loggedIn = true })
        saveFeedStore(feeds2)
        // 通知渲染进程
        try { event.sender.send('feed-login-success', index) } catch (_) {}
        // 延迟关闭窗口，让用户看到成功状态
        setTimeout(() => { try { loginWin.destroy() } catch (_) {} }, 1500)
        resolve({ success: true, loggedIn: true })
      }
    })

    // 用户手动关闭窗口
    loginWin.on('closed', async () => {
      const loggedIn = await checkPlatformLogin(feed.platform, ses)
      if (loggedIn) {
        const feeds2 = getFeedStore()
        feeds2.forEach((f, i) => { if (f.platform === feed.platform) feeds2[i].loggedIn = true })
        saveFeedStore(feeds2)
        try { event.sender.send('feed-login-success', index) } catch (_) {}
        resolve({ success: true, loggedIn: true })
      } else {
        resolve({ success: true, loggedIn: false })
      }
    })
  })
})

ipcMain.handle('feed-check-login', async (event, index) => {
  const feeds = getFeedStore()
  const feed = feeds[index]
  if (!feed) return { loggedIn: false }
  const ses = session.fromPartition('persist:feed-' + feed.platform)
  const loggedIn = await checkPlatformLogin(feed.platform, ses)
  if (loggedIn && !feed.loggedIn) {
    feeds[index].loggedIn = true
    saveFeedStore(feeds)
  }
  return { loggedIn }
})

function getYoutubeChannelRssUrl(url) {
  const m = url.match(/channel\/(UC[\w-]+)/)
  if (m) return 'https://www.youtube.com/feeds/videos.xml?channel_id=' + m[1]
  return null
}

async function fetchYoutubeRss(url) {
  if (url.includes('feeds/videos.xml')) return url
  const directRss = getYoutubeChannelRssUrl(url)
  if (directRss) return directRss
  const html = await fetchWebPage(url)
  const match = html && (html.match(/"channelId":"(UC[\w-]+)"/) || html.match(/channel\/(UC[\w-]+)/))
  if (match) return 'https://www.youtube.com/feeds/videos.xml?channel_id=' + match[1]
  return null
}

async function parseYoutubeRss(rssUrl) {
  const https = require('https')
  return new Promise((resolve, reject) => {
    const req = https.get(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        const items = []
        const re = /<entry>([\s\S]*?)<\/entry>/g
        let m
        while ((m = re.exec(data)) !== null) {
          const e = m[1]
          const id = (e.match(/<yt:videoId>(.*?)<\/yt:videoId>/) || [])[1] || ''
          const title = (e.match(/<title>(.*?)<\/title>/) || [])[1] || ''
          const published = (e.match(/<published>(.*?)<\/published>/) || [])[1] || ''
          const summary = (e.match(/<media:description>([\s\S]*?)<\/media:description>/) || [])[1]?.slice(0, 200) || ''
          if (id) items.push({ id, title, url: 'https://www.youtube.com/watch?v=' + id, publishedAt: published, type: 'video', summary })
        }
        resolve(items)
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('RSS 请求超时')) })
  })
}

async function checkFeedByBrowser(feed, ses) {
  const { BrowserWindow: BW } = require('electron')
  const feedPreloadPath = path.join(__dirname, 'feed-preload.js')
  return new Promise((resolve) => {
    const win = new BW({ width: 1200, height: 800, show: false,
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, preload: feedPreloadPath }
    })
    win.loadURL(feed.url)
    let done = false
    const doResolve = (items) => {
      if (done) return
      done = true
      ipcMain.removeListener('feed-items-collected', onCollected)
      try { win.destroy() } catch (_) {}
      resolve(items || [])
    }
    const onCollected = (ev, result) => {
      if (win.isDestroyed() || ev.sender !== win.webContents) return
      doResolve(result.items || [])
    }
    ipcMain.on('feed-items-collected', onCollected)
    setTimeout(() => doResolve([]), 35000)
  })
}

async function doCheckFeed(feed) {
  if (feed.platform === 'youtube') {
    const rssUrl = await fetchYoutubeRss(feed.url)
    if (!rssUrl) throw new Error('无法获取频道 RSS 地址，请检查链接格式')
    return await parseYoutubeRss(rssUrl)
  } else {
    const ses = session.fromPartition('persist:feed-' + feed.platform)
    return await checkFeedByBrowser(feed, ses)
  }
}

ipcMain.handle('feed-check-one', async (event, index) => {
  const feeds = getFeedStore()
  const feed = feeds[index]
  if (!feed) return { success: false, error: '订阅不存在' }
  try {
    let allItems = await doCheckFeed(feed)
    const isFirstCheck = !feed.lastCheck

    if (isFirstCheck) {
      // 首次检查：全部列出，完全靠 seenIds 去重，不做时间过滤
      feeds[index].seenIds = allItems.map(it => it.id).slice(-200)
      feeds[index].lastCheck = new Date().toISOString()
      saveFeedStore(feeds)
      const todayMapped = allItems.map(it => ({ ...it, platform: feed.platform, sourceName: feed.name }))
      return { success: true, items: todayMapped, isFirstCheck: true, sourceName: feed.name, hasToday: todayMapped.length > 0 }
    }

    // 后续检查：只返回上次检查之后新发布且未读的内容
    const lastCheckTime = new Date(feed.lastCheck)
    let newItems = allItems.filter(it => {
      // 已读过的 ID 一律过滤掉
      if ((feed.seenIds || []).includes(it.id)) return false
      // 有明确时间戳的：必须晚于上次检查时间
      if (it.publishedAt) {
        const pub = new Date(it.publishedAt)
        if (!isNaN(pub.getTime()) && pub <= lastCheckTime) return false
      } else {
        // 无时间戳：依赖 seenIds 去重，已在上面处理，这里视为"新"
        // 但同时保留——下面会立即把它加入 seenIds，下次就不会再显示
      }
      return true
    })
    newItems = newItems.map(it => ({ ...it, platform: feed.platform, sourceName: feed.name }))
    feeds[index].seenIds = [...(feed.seenIds || []), ...newItems.map(it => it.id)].slice(-200)
    feeds[index].lastCheck = new Date().toISOString()
    saveFeedStore(feeds)
    return { success: true, items: newItems }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('feed-check-all', async (event) => {
  const feeds = getFeedStore()
  const allItems = []
  const firstCheckResults = []
  for (let i = 0; i < feeds.length; i++) {
    try {
      const feed = feeds[i]
      let items = await doCheckFeed(feed)
      const isFirstCheck = !feed.lastCheck

      if (isFirstCheck) {
        const todayStart = new Date(); todayStart.setHours(0,0,0,0)
        const todayItems = items.filter(it => !it.publishedAt || new Date(it.publishedAt) >= todayStart)
        feeds[i].seenIds = items.map(it => it.id).slice(-200)
        feeds[i].lastCheck = new Date().toISOString()
        const mapped = todayItems.map(it => ({ ...it, platform: feed.platform, sourceName: feed.name }))
        firstCheckResults.push({ name: feed.name, count: mapped.length })
        allItems.push(...mapped)
      } else {
        const lastCheckTime = new Date(feed.lastCheck)
        let newItems = items.filter(it => {
          if ((feed.seenIds || []).includes(it.id)) return false
          if (it.publishedAt) {
            const pub = new Date(it.publishedAt)
            if (!isNaN(pub.getTime()) && pub <= lastCheckTime) return false
          }
          return true
        })
        newItems = newItems.map(it => ({ ...it, platform: feed.platform, sourceName: feed.name }))
        feeds[i].seenIds = [...(feed.seenIds || []), ...newItems.map(it => it.id)].slice(-200)
        feeds[i].lastCheck = new Date().toISOString()
        allItems.push(...newItems)
      }
    } catch (_) {}
  }
  saveFeedStore(feeds)
  return { success: true, items: allItems, firstCheckResults }
})


// ══════════════════════════════════════════════
// ── 学习助手 IPC Handlers ──
// ══════════════════════════════════════════════

// ── 学习笔记保存 ──
// aipolish: true = AI整理后保存, false = 直接保存原文
ipcMain.handle('study-save-note', async (event, { title, content, aiPolish, outputLang, vaultPath, vaultFolders, inboxFolder, inboxPath }) => {
  const settings = store.get('aiSettings', {})

  let finalContent = content
  let finalTitle = title || '未命名笔记'
  const langInstruction = outputLang === '英文'
    ? 'Please write the entire output in English only. Do not use any Chinese.'
    : '请用中文输出全部内容。'
  const mathInstruction = '所有数学、物理、化学等公式，必须只用标准 LaTeX 语法表示一次（行内公式用 \\( ... \\)，独立公式用 \\[ ... \\]），不要额外用文字、Unicode 符号（如单独的"√"）或 "---" 分隔线去模拟或重复画一遍同一个公式/计算步骤，也不要把公式拆成多行手绘效果。'

  if (aiPolish) {
    if (!settings.apiKey || !settings.modelId) {
      return { success: false, error: '请先在系统设置中配置 API Key 和模型 ID' }
    }
    const polishPrompt = `你是一个笔记整理助手。${langInstruction}${mathInstruction}
请对以下笔记内容进行整理：
1. 纠正错别字和明显的语法错误
2. 适当调整语句使其更通顺
3. 整理成规范的 Markdown 格式
4. 不要改变内容的主要意思和观点
5. 保留原有的所有信息，不要删减内容

笔记标题：${finalTitle}
笔记内容：
${content}

请直接输出整理后的 Markdown 内容，不要加任何说明。`
    try {
      const replyObj = await callVolcanoAI(settings.apiKey, settings.modelId, settings.endpoint,
        [{ role: 'user', content: polishPrompt }], 4000)
      recordTokenUsage('study', 'text', replyObj.usage.prompt_tokens||0, replyObj.usage.completion_tokens||0)
      if (replyObj.content) finalContent = replyObj.content
    } catch (err) {
      return { success: false, error: 'AI 整理失败：' + err.message }
    }
  }

  // 用 smartSaveNote 逻辑保存（AI 匹配文件夹）
  return await doSmartSave({
    content: finalContent,
    vaultPath, vaultFolders, inboxFolder, inboxPath,
    sourceType: '学习笔记',
    sourceTitle: finalTitle,
    settings
  })
})

// ── 知识点扩充 ──
ipcMain.handle('study-expand-knowledge', async (event, { title, description, ageGroup, curriculum, systemType, outputLang, vaultPath, vaultFolders, inboxFolder, inboxPath }) => {
  const settings = store.get('aiSettings', {})
  if (!settings.apiKey || !settings.modelId) {
    return { success: false, error: '请先在系统设置中配置 API Key 和模型 ID' }
  }

  // 根据年龄段/课程/体系生成教学深度说明
  let levelDesc = ''
  if (ageGroup === '小学') {
    if (systemType === '国际') {
      levelDesc = '面向国际学校小学生（6-12岁），参照 Cambridge Primary 或 IB PYP 课程框架，语言简单易懂，多用生动比喻和探究式例子，注重概念理解而非死记硬背，鼓励跨学科联系。'
    } else {
      levelDesc = '面向中国国内小学生（6-12岁），参照人教版课程标准，语言简单易懂，多用生活化例子，与教材知识点紧密结合，注重基础概念的准确性，符合小学阶段的认知水平。'
    }
  } else if (ageGroup === '初中') {
    if (systemType === '国际') {
      levelDesc = '面向国际学校初中生（11-16岁），参照 Cambridge Lower Secondary 或 IB MYP 课程框架，适当引入专业术语，注重概念理解和实际应用，鼓励批判性思维，内容深度适中，避免过于应试化。'
    } else {
      levelDesc = '面向中国国内初中生（12-15岁），参照人教版课程标准，内容紧扣中考考点，术语使用与教材保持一致，适当引入专业术语并加以解释，注重知识点的系统性，结合典型例题帮助理解。'
    }
  } else if (ageGroup === '高中') {
    const currMap = {
      'IGCSE': 'IGCSE课程体系（剑桥国际课程，面向14-16岁），按IGCSE考试大纲要求深度，注重基础但要完整准确，术语使用符合剑桥考试标准。',
      'A-Level': 'A-Level课程体系（英国高中课程），按A-Level考试深度，内容较深，需要涉及原理推导和较复杂的知识点，术语和表达方式符合A-Level标准。',
      'AP': 'AP课程体系（美国大学先修课程），按AP考试要求，内容与大学一年级相当，需要较强的分析能力，术语和概念符合AP课程框架。',
      'IB': 'IB课程体系（国际文凭课程），按IB Diploma要求，重视知识间的联系和批判性思维（TOK视角），内容全面深入，符合IB评估标准。',
      '普通高中': '中国普通高中课程体系，按高考要求深度，内容规范，注重基础知识的系统性和完整性，术语使用与人教版教材保持一致。'
    }
    levelDesc = currMap[curriculum] || 'A-Level课程体系，内容深度适中偏高。'
  }

  const langInstruction = outputLang === '英文'
    ? 'IMPORTANT: Write the entire output in English only. Do not use any Chinese characters.'
    : '请用中文输出全部内容。'
  const mathInstruction = '所有数学、物理、化学等公式，必须只用标准 LaTeX 语法表示一次（行内公式用 \\( ... \\)，独立公式用 \\[ ... \\]），不要额外用文字、Unicode 符号（如单独的"√"）或 "---" 分隔线去模拟或重复画一遍同一个公式/计算步骤，也不要把公式拆成多行手绘效果。'

  const expandPrompt = `你是一位专业的教育内容创作者。${langInstruction}${mathInstruction}
请根据以下信息，对知识点进行系统性扩充和完善。

知识点标题：${title}
用户描述和理解：
${description || '（用户未提供描述）'}

教学对象：${ageGroup}${curriculum ? ' - ' + curriculum : ''}
深度要求：${levelDesc}

请完成以下任务：
1. 如果用户描述中有概念错误，请先指出并纠正
2. 基于正确的基础，系统扩充这个知识点，包括：
   - 核心定义和基本概念
   - 重要原理或规律（根据年龄段决定深度）
   - 具体例子和应用场景
   - 与其他知识点的联系
   - 该年龄段/课程需要重点掌握的内容
3. 内容深度严格符合 ${ageGroup}${curriculum ? ' ' + curriculum : ''} 的学习要求
4. 语言风格适合目标学生群体

请用 Markdown 格式输出，结构清晰，重点突出。`

  try {
    const replyObj = await callVolcanoAI(settings.apiKey, settings.modelId, settings.endpoint,
      [{ role: 'user', content: expandPrompt }], 6000)
    recordTokenUsage('study', 'text', replyObj.usage.prompt_tokens||0, replyObj.usage.completion_tokens||0)

    if (!replyObj.content) return { success: false, error: 'AI 返回内容为空' }

    return { success: true, result: replyObj.content }
  } catch (err) {
    return { success: false, error: 'AI 扩充失败：' + err.message }
  }
})

ipcMain.handle('study-generate-review', async (event, { filePaths, userRequirements, generateType, outputLang, vaultPath }) => {
  const settings = store.get('aiSettings', {})
  if (!settings.apiKey || !settings.modelId) {
    return { success: false, error: '请先在系统设置中配置 API Key 和模型 ID' }
  }

  const allFiles = (filePaths || []).filter(p => p.endsWith('.md') || p.endsWith('.pdf'))
  if (!allFiles.length) return { success: false, error: '没有选择任何文件' }

  const langInstruction = outputLang === '英文'
    ? 'IMPORTANT: Write the entire output in English only. Do not use any Chinese characters.'
    : '请用中文输出全部内容。'
  const mathInstruction = '所有数学、物理、化学等公式，必须只用标准 LaTeX 语法表示一次（行内公式用 \\( ... \\)，独立公式用 \\[ ... \\]），不要额外用文字、Unicode 符号（如单独的"√"）或 "---" 分隔线去模拟或重复画一遍同一个公式/计算步骤，也不要把公式拆成多行手绘效果。'

  // 读取所有文件内容
  const fileSummaries = []
  for (const filePath of allFiles) {
    try {
      const ext = path.extname(filePath).toLowerCase()
      const fileName = path.basename(filePath, ext)
      let body = ''
      if (ext === '.pdf') {
        body = await extractPdfText(filePath, 3000)
      } else {
        const raw = fs.readFileSync(filePath, 'utf-8')
        body = raw.replace(/^---[\s\S]*?---\n?/, '').trim().slice(0, 3000)
      }
      if (body) fileSummaries.push({ fileName, body })
    } catch (_) {}
  }

  if (!fileSummaries.length) return { success: false, error: '所选文件内容为空或无法读取' }

  const combinedContent = fileSummaries.map((f, i) =>
    `【文件${i+1}：${f.fileName}】\n${f.body}`
  ).join('\n\n---\n\n')

  let typeInstruction = ''
  if (generateType === 'review') {
    typeInstruction = '请生成系统的复习资料，包括：核心知识点梳理、重要概念总结、知识框架（可用表格或层级结构）、易错点提醒。'
  } else if (generateType === 'quiz') {
    typeInstruction = `请根据内容生成练习题。格式要求如下：
第一部分：题目（只显示题目，不显示答案）
- 选择题（5-8题）：只列出题目和选项 A/B/C/D，不标注答案
- 填空题（3-5题）：只列出题目，用"___"表示空格
- 简答题（2-3题）：只列出题目

第二部分：答案与解析（放在所有题目之后，用分隔线隔开）
- 对应每道题给出正确答案和详细解析`
  } else {
    typeInstruction = `请生成两部分内容：

第一部分：复习资料
- 核心知识点梳理、重要概念总结、知识框架、易错点提醒

第二部分：练习题（题目部分）
- 选择题（5题）：只列出题目和选项，不标注答案
- 填空题（3题）：只列出题目，用"___"表示空格
- 简答题（2题）：只列出题目

第三部分：答案与解析（用分隔线与题目部分分隔）
- 对应每道题给出正确答案和详细解析`
  }

  const reviewPrompt = `你是一位专业的学习辅导老师。${langInstruction}${mathInstruction}
请根据以下知识库资料，为学生生成学习辅助内容。

${userRequirements ? `学生特别要求：${userRequirements}\n` : ''}

任务说明：
${typeInstruction}

要求：
- 内容要基于所提供的资料，不要凭空编造
- 结构清晰，重点突出
- 使用 Markdown 格式，便于阅读

知识库资料（共${fileSummaries.length}个文件）：
${combinedContent}`

  try {
    const replyObj = await callVolcanoAI(settings.apiKey, settings.modelId, settings.endpoint,
      [{ role: 'user', content: reviewPrompt }], 6000)
    recordTokenUsage('study', 'text', replyObj.usage.prompt_tokens||0, replyObj.usage.completion_tokens||0)

    if (!replyObj.content) return { success: false, error: 'AI 返回内容为空' }

    return { success: true, result: replyObj.content, fileCount: fileSummaries.length }
  } catch (err) {
    return { success: false, error: 'AI 生成失败：' + err.message }
  }
})

// ── 内部辅助函数：统一保存逻辑（供学习助手复用 smartSaveNote）──
async function doSmartSave({ content, vaultPath, vaultFolders, inboxFolder, inboxPath, sourceType, sourceTitle, settings }) {
  const folderList = (vaultFolders || [])
    .map(f => f.label)
    .filter(l => l && l !== '（根目录）')
    .join('、')

  const contentSnippet = (content || '').slice(0, 3000)

  const prompt = `你是一个知识库笔记整理助手。
知识库现有文件夹：${folderList || '（暂无文件夹）'}
笔记来源类型：${sourceType || '未知'}
笔记原始标题：${sourceTitle || '未知'}

请根据以下笔记内容，判断并输出：
1. filename：适合的文件名（不含扩展名，不超过40字，不能含 \\ / : * ? " < > | 等特殊字符）
2. tags：适合的标签（用英文逗号分隔，中文，2~4个）
3. folder：最匹配的文件夹相对路径（必须从上面「知识库现有文件夹」列表中选择，没有合适则输出 ""）

笔记内容（前3000字）：
${contentSnippet}

请严格按以下 JSON 格式回复：
{"filename":"xxx","tags":"xxx,xxx","folder":"xxx"}`

  let aiResult = { filename: '', tags: '', folder: '' }
  try {
    const replyObj = await callVolcanoAI(settings.apiKey, settings.modelId, settings.endpoint,
      [{ role: 'user', content: prompt }], 500)
    recordTokenUsage('save', 'text', replyObj.usage.prompt_tokens||0, replyObj.usage.completion_tokens||0)
    const clean = (replyObj.content||'').replace(/```json|```/g, '').trim()
    aiResult = JSON.parse(clean)
  } catch (_) {}

  const filename = (aiResult.filename || '').replace(/[\\/:*?"<>|]/g, '_').trim() ||
    (sourceTitle || '未命名笔记').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)
  const tags = aiResult.tags || ''
  const aiFolder = (aiResult.folder || '').trim()

  let targetDir = null
  if (aiFolder) {
    const matched = (vaultFolders || []).find(f =>
      f.label && f.label.replace(/\\/g, '/') === aiFolder.replace(/\\/g, '/')
    )
    if (matched && matched.value) targetDir = matched.value
  }

  let usedInbox = false
  if (!targetDir) {
    usedInbox = true
    if (inboxFolder) targetDir = inboxFolder
    else if (inboxPath) targetDir = inboxPath
    else return { success: false, error: '没有匹配的文件夹，且未设置临时文件夹，请先在系统设置中配置。' }
  }

  try {
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true })
  } catch (e) {
    return { success: false, error: '目标文件夹创建失败：' + e.message }
  }

  const now = new Date()
  const dateStr = now.toISOString().slice(0, 10)
  const timeStr = now.toTimeString().slice(0, 5).replace(':', '-')
  const tagArr = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : []
  const tagYaml = tagArr.length ? '[' + tagArr.join(', ') + ']' : '[]'

  const hasOwnFm = content.trimStart().startsWith('---')
  let fileContent
  if (hasOwnFm) {
    fileContent = content
  } else {
    fileContent = `---\ntitle: ${filename}\ndate: ${dateStr}\ntags: ${tagYaml}\nsource: ${sourceType || '学习助手'}\n---\n\n${content}`
  }

  // 避免重名：加时间后缀
  let finalFilename = filename
  let savePath = path.join(targetDir, finalFilename + '.md')
  if (fs.existsSync(savePath)) {
    finalFilename = filename + '_' + timeStr
    savePath = path.join(targetDir, finalFilename + '.md')
  }

  fs.writeFileSync(savePath, fileContent, 'utf-8')

  // 触发 Hub 更新
  try { updateHubFile(targetDir, vaultPath, settings) } catch (_) {}

  return {
    success: true,
    path: savePath,
    filename: finalFilename + '.md',
    folder: aiFolder || '（临时文件夹）',
    usedInbox,
    tags
  }
}

// ── PDF 导出：公用 HTML 模板（内嵌本地 KaTeX 样式，保证公式正确显示）──
// htmlBody 必须是已经用 KaTeX 渲染过公式的 HTML（渲染在渲染进程完成，这里只负责拼页面+加载样式）
function buildPdfHtmlDocument(htmlBody, title) {
  const katexCssPath = path.join(__dirname, 'katex', 'katex.min.css')
  const katexCssHref = pathToFileURL(katexCssPath).href
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link rel="stylesheet" href="${katexCssHref}">
<style>
  body{font-family:'Microsoft YaHei',Arial,sans-serif;margin:28px 36px;line-height:1.9;color:#222;font-size:14px}
  h1{font-size:20px;color:#2c2c2a;border-bottom:2px solid #534ab7;padding-bottom:6px;margin-bottom:16px}
  h2{font-size:16px;color:#3c3489;margin-top:18px;margin-bottom:8px}
  h3{font-size:14px;color:#444;margin-top:14px;margin-bottom:6px}
  li{margin:4px 0;line-height:1.7}
  p{margin:6px 0}
  strong{font-weight:600;color:#1a1a1a}
  hr{border:none;border-top:1px solid #ddd;margin:16px 0}
  .katex-display-wrap{margin:12px 0}
  .katex-display{overflow-x:auto}
</style>
<title>${title || '学习资料'}</title>
</head><body>
<h1>${title || '学习资料'}</h1>
<div>${htmlBody}</div>
</body></html>`
}

// ── PDF 导出：公用渲染逻辑（隐藏 BrowserWindow + printToPDF）──
// 注意：不能用 data: 地址加载页面——浏览器会把它当成和本地字体文件不同的来源，
// 可能悄悄加载字体失败并换成系统字体（不报错，但根号等符号会因此变形错位）。
// 改为把 HTML 写入一个临时文件，用和软件主界面一样的 file:// 方式加载，避免这个问题。
async function renderHtmlToPdfBuffer(htmlBody, title) {
  const { BrowserWindow: BW } = require('electron')
  const fullHtml = buildPdfHtmlDocument(htmlBody, title)
  const os = require('os')
  const tempPath = path.join(os.tmpdir(), 'notewell-pdf-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.html')
  fs.writeFileSync(tempPath, fullHtml, 'utf-8')

  const win = new BW({ show: false, webPreferences: { nodeIntegration: false } })
  try {
    await win.loadFile(tempPath)
    // 等待 KaTeX 专用字体真正加载完成，否则公式里的根号/上下标会用替代字体的错误宽度排版，导致错位乱码
    try {
      await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
    } catch (_) {}
    // 字体加载完成后再多等一小段时间，确保页面完成重新排版
    await new Promise(resolve => setTimeout(resolve, 300))
    const pdfBuffer = await win.webContents.printToPDF({
      marginsType: 1,
      pageSize: 'A4',
      printBackground: false,
      landscape: false
    })
    return pdfBuffer
  } finally {
    win.destroy()
    try { fs.unlinkSync(tempPath) } catch (_) {}
  }
}

// ── 学习助手：导出 PDF（用户手动点击"下载 PDF"，弹出另存为对话框）──
ipcMain.handle('study-export-pdf', async (event, { htmlBody, title }) => {
  try {
    const saveResult = await dialog.showSaveDialog(mainWindow, {
      title: '保存 PDF 文件',
      defaultPath: (title || '学习资料') + '.pdf',
      filters: [{ name: 'PDF 文件', extensions: ['pdf'] }]
    })
    if (saveResult.canceled || !saveResult.filePath) return { success: false, error: '已取消' }

    const savePath = saveResult.filePath
    const pdfBuffer = await renderHtmlToPdfBuffer(htmlBody, title)
    fs.writeFileSync(savePath, pdfBuffer)
    shell.showItemInFolder(savePath)
    return { success: true, path: savePath }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ── 含公式内容保存为 PDF：按文件名用 AI 语义判断应归入哪个知识库文件夹 ──
// （只把文件名交给 AI，不读取 PDF 正文内容）
async function matchFolderByFilenameAI(filename, vaultFolders, settings) {
  const folderList = (vaultFolders || [])
    .map(f => f.label)
    .filter(l => l && l !== '（根目录）')
    .join('、')

  if (!folderList || !settings || !settings.apiKey || !settings.modelId) return ''

  const prompt = `你是一个知识库文件归类助手。
知识库现有文件夹：${folderList}

请根据下面这个文件名，判断它在语义上最应该归入上面哪一个文件夹（不是按文字是否相同匹配，而是理解文件名所代表的学科/主题含义，例如"勾股定理.pdf"应归入数学类文件夹）。
如果找不到合适的文件夹，输出空字符串。

文件名：${filename}

请严格按以下 JSON 格式回复，不要加任何其他文字：
{"folder":"xxx"}`

  try {
    const replyObj = await callVolcanoAI(settings.apiKey, settings.modelId, settings.endpoint,
      [{ role: 'user', content: prompt }], 200)
    recordTokenUsage('save', 'text', replyObj.usage.prompt_tokens || 0, replyObj.usage.completion_tokens || 0)
    const clean = (replyObj.content || '').replace(/```json|```/g, '').trim()
    const aiResult = JSON.parse(clean)
    const aiFolder = (aiResult.folder || '').trim()
    if (!aiFolder) return ''
    const matched = (vaultFolders || []).find(f =>
      f.label && f.label.replace(/\\/g, '/') === aiFolder.replace(/\\/g, '/')
    )
    return matched && matched.value ? matched.value : ''
  } catch (_) {
    return ''
  }
}

// ── 检测到公式后，用户选择"保存为 PDF"：渲染 PDF + AI 按文件名归类 + 写入知识库 ──
ipcMain.handle('pdf-smart-save', async (event, { htmlBody, filename, sourceTitle, vaultPath, vaultFolders, inboxFolder, inboxPath }) => {
  const settings = store.get('aiSettings', {})

  const safeName = (filename || sourceTitle || '未命名笔记').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 60) || '未命名笔记'

  let targetDir = await matchFolderByFilenameAI(safeName, vaultFolders, settings)
  let usedInbox = false
  let noMatch = false

  if (!targetDir) {
    noMatch = true
    if (inboxFolder) {
      targetDir = inboxFolder
      usedInbox = true
    } else if (inboxPath) {
      targetDir = inboxPath
      usedInbox = true
    } else {
      return { success: false, error: '没有匹配的文件夹，且未设置临时文件夹，请先在系统设置中配置。' }
    }
  }

  try {
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true })
  } catch (e) {
    return { success: false, error: '目标文件夹创建失败：' + e.message }
  }

  let pdfBuffer
  try {
    pdfBuffer = await renderHtmlToPdfBuffer(htmlBody, sourceTitle || safeName)
  } catch (e) {
    return { success: false, error: 'PDF 生成失败：' + e.message }
  }

  let finalFilename = safeName
  let savePath = path.join(targetDir, finalFilename + '.pdf')
  let i = 2
  while (fs.existsSync(savePath)) {
    finalFilename = safeName + '_' + i
    savePath = path.join(targetDir, finalFilename + '.pdf')
    i++
  }

  try {
    fs.writeFileSync(savePath, pdfBuffer)
  } catch (e) {
    return { success: false, error: '文件写入失败：' + e.message }
  }

  try { updateHubFile(targetDir, vaultPath, settings) } catch (_) {}

  return {
    success: true,
    path: savePath,
    filename: finalFilename + '.pdf',
    folder: noMatch ? '（临时文件夹）' : path.basename(targetDir),
    usedInbox,
    noMatch
  }
})
ipcMain.handle('read-file-content', async (event, filePath) => {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    return { success: true, content }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ── 学习助手：统一保存（知识点扩充、复习备考内容保存）──
ipcMain.handle('study-smart-save', async (event, { content, vaultPath, vaultFolders, inboxFolder, inboxPath, sourceType, sourceTitle }) => {
  const settings = store.get('aiSettings', {})
  if (!settings.apiKey || !settings.modelId) {
    return { success: false, error: '请先在系统设置中配置 API Key 和模型 ID' }
  }
  return await doSmartSave({ content, vaultPath, vaultFolders, inboxFolder, inboxPath, sourceType, sourceTitle, settings })
})
