// Notewell 用量统计 / 反馈查看接口，仅供开发者本人使用。
// 需要在请求头带上 x-admin-secret，跟 Vercel 环境变量 ADMIN_SECRET 一致才能访问。
// 没配置 ADMIN_SECRET 时一律拒绝，避免忘记设置密码导致数据裸奔。

import { neon } from '@neondatabase/serverless'

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null

async function ensureUsageTable() {
  if (!sql) return
  await sql`
    CREATE TABLE IF NOT EXISTS usage_logs (
      id BIGSERIAL PRIMARY KEY,
      license_code TEXT,
      device_id TEXT NOT NULL,
      call_type TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' })
  }

  const secret = req.headers['x-admin-secret']
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' })
  }

  if (!sql) {
    return res.status(200).json({ success: false, error: '数据库未配置（缺少 DATABASE_URL）' })
  }

  try {
    await ensureUsageTable()
    const dateParam = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365)

    const dailyPromise = dateParam
      ? sql`
          SELECT
            date_trunc('day', created_at) AS day,
            COUNT(*) AS calls,
            COUNT(DISTINCT COALESCE(license_code, device_id)) AS users,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens
          FROM usage_logs
          WHERE created_at::date = ${dateParam}::date
          GROUP BY day
        `
      : sql`
          SELECT
            date_trunc('day', created_at) AS day,
            COUNT(*) AS calls,
            COUNT(DISTINCT COALESCE(license_code, device_id)) AS users,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens
          FROM usage_logs
          WHERE created_at > now() - make_interval(days => ${days})
          GROUP BY day
          ORDER BY day DESC
        `

    const [totalsRows, userRows, dailyRows, feedback, licenses] = await Promise.all([
      sql`
        SELECT
          COUNT(DISTINCT COALESCE(license_code, device_id)) AS total_users,
          COUNT(*) AS total_calls,
          COALESCE(SUM(input_tokens), 0) AS total_input,
          COALESCE(SUM(output_tokens), 0) AS total_output
        FROM usage_logs
      `,
      sql`
        SELECT
          COALESCE(license_code, device_id) AS identity,
          MAX(license_code) AS license_code,
          MAX(device_id) AS device_id,
          COUNT(*) AS total_calls,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          MIN(created_at) AS first_seen,
          MAX(created_at) AS last_seen,
          COUNT(*) FILTER (WHERE created_at > now() - interval '7 days') AS calls_7d,
          COUNT(*) FILTER (WHERE created_at > now() - interval '30 days') AS calls_30d
        FROM usage_logs
        GROUP BY identity
        ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC
      `,
      dailyPromise,
      fetchFeedback(),
      fetchAfdianLicenses()
    ])

    return res.status(200).json({
      success: true,
      totals: totalsRows[0] || { total_users: 0, total_calls: 0, total_input: 0, total_output: 0 },
      users: userRows,
      daily: dailyRows,
      feedback,
      licenses
    })
  } catch (e) {
    return res.status(500).json({ success: false, error: String((e && e.message) || e) })
  }
}

function parseCodeList(envValue) {
  return (envValue || '').split(',').map(c => c.trim()).filter(Boolean)
}

// 爱发电激活码使用情况：以环境变量里配置的码为准，对照数据库里的激活记录，
// 看每个码是"未使用"还是"已激活"，以及激活日期、到期日、累计调用 AI 的次数。
// 任何一步失败都只让这一块显示为空，不影响页面上其它统计。
async function fetchAfdianLicenses() {
  const annualCodes = parseCodeList(process.env.AFDIAN_ANNUAL_CODES)
  const lifetimeCodes = parseCodeList(process.env.AFDIAN_LIFETIME_CODES)
  const empty = { available: false, annual: { total: 0, used: 0, items: [] }, lifetime: { total: 0, used: 0, items: [] } }
  if (!annualCodes.length && !lifetimeCodes.length) return empty

  try {
    await sql`ALTER TABLE license_devices ADD COLUMN IF NOT EXISTS first_activated_at TIMESTAMPTZ`
    const bindRows = await sql`SELECT license_code, first_activated_at, updated_at FROM license_devices`
    const usageRows = await sql`
      SELECT license_code, COUNT(*) AS calls,
             COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS tokens
      FROM usage_logs WHERE license_code IS NOT NULL GROUP BY license_code
    `
    const bindMap = new Map(bindRows.map(r => [r.license_code, r]))
    const usageMap = new Map(usageRows.map(r => [r.license_code, r]))

    const build = (codes, isAnnual) => {
      const items = codes.map(code => {
        const b = bindMap.get(code)
        const u = usageMap.get(code)
        const activated = !!b
        const firstAt = b && b.first_activated_at ? new Date(b.first_activated_at) : null
        let expiresAt = null
        let expired = false
        if (isAnnual && firstAt) {
          expiresAt = new Date(firstAt.getTime() + 365 * 24 * 60 * 60 * 1000)
          expired = expiresAt.getTime() <= Date.now()
        }
        return {
          code,
          activated,
          firstActivatedAt: firstAt ? firstAt.toISOString() : null,
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
          expired,
          lastBoundAt: b && b.updated_at ? new Date(b.updated_at).toISOString() : null,
          calls: u ? Number(u.calls) : 0,
          tokens: u ? Number(u.tokens) : 0
        }
      })
      return { total: items.length, used: items.filter(i => i.activated).length, items }
    }

    return { available: true, annual: build(annualCodes, true), lifetime: build(lifetimeCodes, false) }
  } catch (e) {
    console.error('afdian license stats failed:', e && e.message)
    return empty
  }
}

async function fetchFeedback() {
  if (!process.env.GITHUB_ISSUE_TOKEN) return { available: false, items: [] }
  try {
    const resp = await fetch(
      'https://api.github.com/repos/xjyammia-star/Notewell/issues?state=all&labels=user-feedback&per_page=50&sort=created&direction=desc',
      {
        headers: {
          'Authorization': 'Bearer ' + process.env.GITHUB_ISSUE_TOKEN,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'notewell-admin-stats'
        }
      }
    )
    if (!resp.ok) return { available: false, items: [] }
    const issues = await resp.json()
    return {
      available: true,
      items: issues.map(it => ({
        title: it.title,
        body: it.body,
        url: it.html_url,
        state: it.state,
        createdAt: it.created_at
      }))
    }
  } catch (e) {
    return { available: false, items: [] }
  }
}
