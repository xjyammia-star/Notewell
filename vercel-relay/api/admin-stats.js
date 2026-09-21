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
    const [totalsRows, userRows, feedback] = await Promise.all([
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
        ORDER BY (input_tokens + output_tokens) DESC
      `,
      fetchFeedback()
    ])

    return res.status(200).json({
      success: true,
      totals: totalsRows[0] || { total_users: 0, total_calls: 0, total_input: 0, total_output: 0 },
      users: userRows,
      feedback
    })
  } catch (e) {
    return res.status(500).json({ success: false, error: String((e && e.message) || e) })
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
