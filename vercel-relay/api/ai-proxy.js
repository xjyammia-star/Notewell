// Notewell AI 中转服务
// 作用：客户端把请求发到这里，这里再用 Vercel 环境变量里的 Key
// 去调用火山引擎方舟平台。API Key 只存在这里，不会出现在客户端代码里。

import { neon } from '@neondatabase/serverless'

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null

let tableReady = false
async function ensureUsageTable() {
  if (tableReady || !sql) return
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
  tableReady = true
}

// 记录一次用量。任何失败都只打日志、不抛出——统计功能绝不能影响 AI 请求本身能不能用。
async function logUsage({ licenseCode, deviceId, callType, usage }) {
  if (!sql || !deviceId) return
  try {
    await ensureUsageTable()
    const inputTokens = (usage && (usage.prompt_tokens ?? usage.input_tokens)) || 0
    const outputTokens = (usage && (usage.completion_tokens ?? usage.output_tokens)) || 0
    await sql`
      INSERT INTO usage_logs (license_code, device_id, call_type, input_tokens, output_tokens)
      VALUES (${licenseCode || null}, ${deviceId}, ${callType}, ${inputTokens}, ${outputTokens})
    `
  } catch (e) {
    console.error('usage log failed:', e && e.message)
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' })
  }

  // 简易口令校验：不是强安全措施，只是防止网址被随便发现后被人白嫖调用
  const secret = req.headers['x-relay-secret']
  if (!process.env.RELAY_SHARED_SECRET || secret !== process.env.RELAY_SHARED_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' })
  }

  const { type, messages, maxTokens, imageBase64, mimeType, prompt, licenseCode, deviceId } = req.body || {}

  try {
    if (type === 'text' || type === 'health') {
      const result = await callArk({
        apiKey: process.env.ARK_API_KEY,
        modelId: process.env.ARK_MODEL_ID,
        endpoint: process.env.ARK_ENDPOINT || 'https://ark.cn-beijing.volces.com/api/v3',
        messages: type === 'health'
          ? [{ role: 'user', content: '你好，请回复 OK' }]
          : messages,
        maxTokens: type === 'health' ? 5 : maxTokens
      })
      if (type === 'text' && result.success) {
        await logUsage({ licenseCode, deviceId, callType: 'text', usage: result.usage })
      }
      return res.status(200).json(result)
    }

    if (type === 'vision' || type === 'health_vision') {
      const visionMessages = [{
        role: 'user',
        content: [
          { type: 'text', text: type === 'health_vision' ? '这张图是什么颜色？一个词回答' : (prompt || '') },
          {
            type: 'image_url',
            image_url: {
              url: type === 'health_vision'
                ? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGPYYmNDEmIY1TCqYfhqAAD19SwQ/QoZMQAAAABJRU5ErkJggg=='
                : `data:${mimeType || 'image/jpeg'};base64,${imageBase64}`
            }
          }
        ]
      }]
      const result = await callArk({
        apiKey: process.env.ARK_VISION_API_KEY || process.env.ARK_API_KEY,
        modelId: process.env.ARK_VISION_MODEL_ID,
        endpoint: process.env.ARK_VISION_ENDPOINT || process.env.ARK_ENDPOINT || 'https://ark.cn-beijing.volces.com/api/v3',
        messages: visionMessages,
        maxTokens: type === 'health_vision' ? 5 : maxTokens
      })
      if (type === 'vision' && result.success) {
        await logUsage({ licenseCode, deviceId, callType: 'vision', usage: result.usage })
      }
      return res.status(200).json(result)
    }

    return res.status(400).json({ success: false, error: 'Unknown request type' })
  } catch (err) {
    return res.status(500).json({ success: false, error: String((err && err.message) || err) })
  }
}

async function callArk({ apiKey, modelId, endpoint, messages, maxTokens }) {
  if (!apiKey || !modelId) {
    return { success: false, error: '服务端未配置 API Key 或模型 ID（请检查 Vercel 环境变量）' }
  }
  const url = endpoint.replace(/\/+$/, '') + '/chat/completions'
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: modelId,
      messages,
      max_tokens: maxTokens || 500,
      thinking: { type: 'disabled' }
    })
  })
  const data = await resp.json()
  if (!resp.ok) {
    const msg = (data && data.error && data.error.message) || `请求失败（状态码 ${resp.status}）`
    return { success: false, error: msg }
  }
  const choice = data && data.choices && data.choices[0]
  const text = choice && choice.message && choice.message.content
  return { success: true, text, usage: data && data.usage }
}
