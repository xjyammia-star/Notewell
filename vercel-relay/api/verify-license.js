// Notewell 激活码验证服务（朋友白名单）
// 作用：客户端把用户输入的激活码发到这里，服务端拿 Vercel 环境变量里的
// FRIEND_CODES 列表做比对。匹配上就是好友账户，永久有效。
// 白名单码只存在这里（Vercel 环境变量），绝不出现在客户端代码里。

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' })
  }

  // 复用跟 ai-proxy 一样的口令校验，防止接口被随便发现后被外部乱调用
  const secret = req.headers['x-relay-secret']
  if (!process.env.RELAY_SHARED_SECRET || secret !== process.env.RELAY_SHARED_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' })
  }

  const { code } = req.body || {}
  const trimmedCode = (code || '').trim()
  if (!trimmedCode) {
    return res.status(200).json({ success: true, valid: false, error: '请输入激活码' })
  }

  // FRIEND_CODES 环境变量：英文逗号分隔的多个码，例如 "xu2026,friend001,vip888"
  const friendCodes = (process.env.FRIEND_CODES || '')
    .split(',')
    .map(c => c.trim())
    .filter(Boolean)

  const matched = friendCodes.includes(trimmedCode)

  if (matched) {
    return res.status(200).json({
      success: true,
      valid: true,
      type: 'friend',
      expiresAt: null // 好友码永久有效，不设到期时间
    })
  }

  return res.status(200).json({ success: true, valid: false, error: '激活码无效，请检查输入是否正确' })
}
