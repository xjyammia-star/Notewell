// Notewell 激活码验证服务
// 优先级：1. 好友白名单码（永久免费）  2. Payhip 付费激活码（年付/终身）
// 敏感信息（白名单码列表、Payhip Product Secret Key、数据库连接串）只存在这里的
// Vercel 环境变量里，绝不出现在客户端代码里。
//
// 设备限制：同一个激活码，同一时间只允许绑定在一台设备上。新设备激活会
// 直接顶替旧设备的绑定；旧设备下次调用 AI 功能时（action=check）会发现
// 自己已经不是绑定设备，被打回未激活状态。

import { neon } from '@neondatabase/serverless'

const sql = neon(process.env.DATABASE_URL)

async function bindDevice(licenseCode, deviceId) {
  await sql`
    INSERT INTO license_devices (license_code, device_id, updated_at)
    VALUES (${licenseCode}, ${deviceId}, now())
    ON CONFLICT (license_code)
    DO UPDATE SET device_id = EXCLUDED.device_id, updated_at = now()
  `
}

async function checkDeviceBinding(licenseCode, deviceId) {
  const rows = await sql`SELECT device_id FROM license_devices WHERE license_code = ${licenseCode}`
  if (rows.length === 0) {
    // 数据库里还没有这个码的绑定记录（比如历史遗留的老激活），当作首次绑定处理，
    // 不能因为"查无记录"就把正常在用的用户判定为无效
    await bindDevice(licenseCode, deviceId)
    return true
  }
  return rows[0].device_id === deviceId
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' })
  }

  const secret = req.headers['x-relay-secret']
  if (!process.env.RELAY_SHARED_SECRET || secret !== process.env.RELAY_SHARED_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' })
  }

  const { code, deviceId, action } = req.body || {}
  const trimmedCode = (code || '').trim()
  if (!trimmedCode) {
    return res.status(200).json({ success: true, valid: false, error: '请输入激活码' })
  }

  // ── action = 'check'：日常使用 AI 功能前的轻量设备核对，不重新验证码本身是否有效 ──
  if (action === 'check') {
    try {
      const ok = await checkDeviceBinding(trimmedCode, deviceId)
      return res.status(200).json({ success: true, deviceOk: ok })
    } catch (e) {
      // 数据库暂时不可用：不因为这种偶发问题惩罚正常用户，按"设备没问题"放行
      return res.status(200).json({ success: true, deviceOk: true })
    }
  }

  // ── action = 'activate'（默认）：真正的激活流程 ──

  // 第一步：好友白名单码（FRIEND_CODES，逗号分隔，永久有效）
  const friendCodes = (process.env.FRIEND_CODES || '')
    .split(',')
    .map(c => c.trim())
    .filter(Boolean)

  if (friendCodes.includes(trimmedCode)) {
    try { await bindDevice(trimmedCode, deviceId) } catch (e) { /* 绑定失败不影响本次激活成功 */ }
    return res.status(200).json({ success: true, valid: true, type: 'friend', expiresAt: null })
  }

  // 第二步：不是好友码，尝试当作 Payhip 激活码验证
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
      return res.status(200).json({ success: true, valid: false, error: '激活码无效或已失效，请检查是否正确、或联系客服' })
    }

    let result = null
    if (info.variant_name === '年付版') {
      const purchaseDate = new Date(info.date)
      const expiresAt = new Date(purchaseDate.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString()
      result = { type: 'annual', expiresAt }
    } else if (info.variant_name === '终身版') {
      result = { type: 'lifetime', expiresAt: null }
    }

    if (!result) {
      return res.status(200).json({ success: true, valid: false, error: '激活码有效，但无法识别版本类型，请联系客服处理' })
    }

    try { await bindDevice(trimmedCode, deviceId) } catch (e) { /* 绑定失败不影响本次激活成功 */ }
    return res.status(200).json({ success: true, valid: true, type: result.type, expiresAt: result.expiresAt })
  } catch (e) {
    return res.status(200).json({ success: true, valid: false, error: '验证服务暂时不可用，请稍后再试' })
  }
}
