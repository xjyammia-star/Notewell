// Notewell 激活码验证服务
// 优先级：1. 好友白名单码（永久免费）  2. Payhip 付费激活码（年付/终身）
// 敏感信息（白名单码列表、Payhip Product Secret Key）只存在这里的 Vercel 环境变量里，
// 绝不出现在客户端代码里。

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' })
  }

  const secret = req.headers['x-relay-secret']
  if (!process.env.RELAY_SHARED_SECRET || secret !== process.env.RELAY_SHARED_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' })
  }

  const { code } = req.body || {}
  const trimmedCode = (code || '').trim()
  if (!trimmedCode) {
    return res.status(200).json({ success: true, valid: false, error: '请输入激活码' })
  }

  // ── 第一步：好友白名单码（FRIEND_CODES，逗号分隔，永久有效） ──
  const friendCodes = (process.env.FRIEND_CODES || '')
    .split(',')
    .map(c => c.trim())
    .filter(Boolean)

  if (friendCodes.includes(trimmedCode)) {
    return res.status(200).json({
      success: true,
      valid: true,
      type: 'friend',
      expiresAt: null
    })
  }

  // ── 第二步：不是好友码，尝试当作 Payhip 激活码验证 ──
  if (!process.env.PAYHIP_PRODUCT_SECRET_KEY) {
    return res.status(200).json({ success: true, valid: false, error: '激活码无效，请检查输入是否正确' })
  }

  try {
    const payhipResp = await fetch(
      'https://payhip.com/api/v2/license/verify?license_key=' + encodeURIComponent(trimmedCode),
      { headers: { 'product-secret-key': process.env.PAYHIP_PRODUCT_SECRET_KEY } }
    )

    if (!payhipResp.ok) {
      return res.status(200).json({ success: true, valid: false, error: '激活码无效，请检查输入是否正确' })
    }

    const payhipData = await payhipResp.json().catch(() => null)
    const info = payhipData && payhipData.data
    if (!info || !info.license_key || !info.enabled) {
      // enabled=false 常见于已退款、或被手动停用的激活码
      return res.status(200).json({ success: true, valid: false, error: '激活码无效或已失效，请检查是否正确、或联系客服' })
    }

    // 变体名称必须跟 Payhip 商品页里配置的完全一致（含中文全角括号），一个字符都不能错
    if (info.variant_name === '年付版') {
      const purchaseDate = new Date(info.date)
      const expiresAt = new Date(purchaseDate.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString()
      return res.status(200).json({
        success: true,
        valid: true,
        type: 'annual',
        expiresAt
      })
    }

    if (info.variant_name === '终身版') {
      return res.status(200).json({
        success: true,
        valid: true,
        type: 'lifetime',
        expiresAt: null
      })
    }

    // 验证通过但变体名称对不上（比如商品页改过名字），保险起见当作无效处理
    return res.status(200).json({ success: true, valid: false, error: '激活码有效，但无法识别版本类型，请联系客服处理' })
  } catch (e) {
    return res.status(200).json({ success: true, valid: false, error: '验证服务暂时不可用，请稍后再试' })
  }
}
