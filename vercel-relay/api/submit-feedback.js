// Notewell 用户反馈提交服务
// 收到反馈后，通过 GitHub API 在 Notewell 仓库里自动创建一个 Issue，
// 方便统一在 GitHub 的 Issues 列表里查看、标记处理状态，不需要额外的后台界面。
// GITHUB_ISSUE_TOKEN 只在这里使用，绝不出现在客户端代码里，且只对 Notewell
// 这一个仓库开了 Issues 的读写权限（其他仓库/账号权限完全无关）。

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' })
  }

  const secret = req.headers['x-relay-secret']
  if (!process.env.RELAY_SHARED_SECRET || secret !== process.env.RELAY_SHARED_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' })
  }

  if (!process.env.GITHUB_ISSUE_TOKEN) {
    return res.status(200).json({ success: false, error: '反馈服务暂未配置，请稍后再试' })
  }

  const { content, appVersion, platform } = req.body || {}
  const trimmed = (content || '').trim()
  if (!trimmed) {
    return res.status(200).json({ success: false, error: '请填写反馈内容' })
  }

  // 标题取内容前 40 个字符，方便在 Issue 列表里一眼看出大概是什么问题
  const title = '[用户反馈] ' + (trimmed.length > 40 ? trimmed.slice(0, 40) + '…' : trimmed)

  const body = [
    trimmed,
    '',
    '---',
    `版本：${appVersion || '未知'}`,
    `系统：${platform || '未知'}`,
    `提交时间：${new Date().toISOString()}`
  ].join('\n')

  try {
    const ghResp = await fetch('https://api.github.com/repos/xjyammia-star/Notewell/issues', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.GITHUB_ISSUE_TOKEN,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'notewell-feedback',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ title, body, labels: ['user-feedback'] })
    })

    if (!ghResp.ok) {
      return res.status(200).json({ success: false, error: '提交失败，请稍后再试（服务异常）' })
    }

    return res.status(200).json({ success: true })
  } catch (e) {
    return res.status(200).json({ success: false, error: '提交失败，请检查网络后重试' })
  }
}
