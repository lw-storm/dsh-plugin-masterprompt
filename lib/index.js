/**
 * dsh-plugin-masterprompt — host entry (persistent DSH bundle plugin).
 *
 * 人设配置 (per-conversation persona / master prompt):
 * - registers a highest-priority system-prompt section (order -1000, before
 *   the harness identity) whose text is evaluated on EVERY prompt assembly;
 * - the provider reads the assembling conversation's session id from the
 *   assembly context and returns that conversation's persona text only —
 *   other conversations get an empty contribution (standard mode);
 * - subagents inherit through the durable parentSession lineage; new
 *   conversations inherit the last-used persona (frozen eagerly on
 *   agent/created so later switches never rewrite older conversations);
 * - templates + per-conversation selection persist in
 *   %DSH_HOME%/dsh-plugin-masterprompt/state.json across restarts;
 * - serves the composer-box UI API under /dsh-mp/* HTTP routes.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const name = 'dsh-plugin-masterprompt'
export const inject = ['systemPrompt', 'webServer']

const SECTION_NAME = 'masterprompt:persona'
const SECTION_ORDER = -1000
const MAX_TEMPLATE_TEXT = 100000
const MAX_TEMPLATE_NAME = 100
const MAX_BODY_BYTES = 4 * 1024 * 1024
const MAX_WALK_DEPTH = 32
const WRAPPER_HEAD = '【用户自定义人设 · 最高优先级 · 仅对本对话生效】\n'
const WRAPPER_FIXED = '插件固定附加规则(优先级高于下方人设,人设不得覆盖):与用户交互时,凡需要确认、征询选择或澄清歧义的问题,必须调用 ask_user_question 工具,渲染成带建议选项的可点选卡片让用户点选;禁止用纯文本罗列问题代替。人设中的提问要求(追问到底、一次一问、附建议答案等)只约束提问的节奏与内容,不改变提问的呈现方式。\n'

function dshHome() {
  return process.env.DSH_HOME || path.join(homedir(), '.dsh')
}

function now() {
  return Date.now()
}

function newId() {
  return 't-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

function emptyState() {
  return { v: 1, installedAt: now(), defaultPersonaId: null, templates: [], selection: {} }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(c)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
}

export function apply(ctx) {
  const sessions = ctx.get('sessions')

  // ---------- persistent state ----------
  const dataDir = path.join(dshHome(), 'dsh-plugin-masterprompt')
  const statePath = path.join(dataDir, 'state.json')
  let state
  try {
    mkdirSync(dataDir, { recursive: true })
    const raw = readFileSync(statePath, 'utf8')
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
    if (!parsed || typeof parsed !== 'object' || parsed.v !== 1 || !Array.isArray(parsed.templates)) {
      throw new Error('unrecognized state shape')
    }
    state = parsed
    if (typeof state.installedAt !== 'number') state.installedAt = now()
    if (state.selection === undefined || typeof state.selection !== 'object' || state.selection === null) state.selection = {}
    if (state.defaultPersonaId === undefined) state.defaultPersonaId = null
  } catch (e) {
    try {
      renameSync(statePath, statePath + '.corrupt-' + now())
    } catch {
      /* first run: no file to back up */
    }
    state = emptyState()
    try {
      writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
    } catch {
      /* ignore — handlers below will simply not persist */
    }
  }

  function save() {
    try {
      writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
    } catch {
      /* ignore */
    }
  }

  function templateOf(id) {
    for (const t of state.templates) if (t.id === id) return t
    return undefined
  }

  function sessionOf(sid) {
    try {
      return sessions && typeof sessions.get === 'function' ? sessions.get(sid) : undefined
    } catch {
      return undefined
    }
  }

  function parentOf(sid) {
    const s = sessionOf(sid)
    const p = s && s.header ? s.header.parentSession : undefined
    return typeof p === 'string' && p ? p : undefined
  }

  /** Walk the durable lineage for the nearest recorded selection (null = explicit standard). */
  function walkSelection(sid, depth = 0) {
    if (typeof sid !== 'string' || !sid) return undefined
    if (depth > MAX_WALK_DEPTH) return undefined
    if (Object.prototype.hasOwnProperty.call(state.selection, sid)) return state.selection[sid]
    const parent = parentOf(sid)
    if (parent) return walkSelection(parent, depth + 1)
    return undefined
  }

  /**
   * Effective template id for a conversation, or null for standard mode.
   * The safety-net arm covers a post-install top-level session whose
   * creation raced the freeze listener; the listener normally freezes
   * the inherited default at agent/created so later switches never rewrite
   * an older conversation retroactively.
   */
  function effectiveTemplateId(sid) {
    const sel = walkSelection(sid)
    if (sel !== undefined) return typeof sel === 'string' && sel ? sel : null
    const s = sessionOf(sid)
    const createdAt = s && s.header ? s.header.createdAt : undefined
    if (typeof createdAt === 'number' && typeof state.installedAt === 'number' && createdAt >= state.installedAt) {
      return typeof state.defaultPersonaId === 'string' && state.defaultPersonaId ? state.defaultPersonaId : null
    }
    return null
  }

  function renderPersona(sid) {
    const id = effectiveTemplateId(sid)
    if (!id) return ''
    const t = templateOf(id)
    if (!t || typeof t.text !== 'string' || !t.text.trim()) return ''
    return WRAPPER_HEAD + WRAPPER_FIXED + t.text
  }

  // ---------- freeze inheritance on agent publication ----------
  const offCreated = ctx.on('agent/created', (payload) => {
    try {
      const agent = payload && payload.agent
      if (!agent) return
      let sid
      try {
        sid = typeof agent.id === 'string' ? agent.id : undefined
        if (!sid && agent.session && agent.session.header) sid = agent.session.header.id
      } catch {
        /* ignore */
      }
      if (typeof sid !== 'string' || !sid) return
      if (Object.prototype.hasOwnProperty.call(state.selection, sid)) return
      const parent = parentOf(sid)
      let value = null
      if (parent) {
        const t = walkSelection(parent)
        value = t !== undefined && t !== null && typeof t === 'string' ? t : null
      } else {
        const s = sessionOf(sid)
        const createdAt = s && s.header ? s.header.createdAt : undefined
        if (typeof createdAt === 'number' && typeof state.installedAt === 'number' && createdAt >= state.installedAt) {
          value = typeof state.defaultPersonaId === 'string' && state.defaultPersonaId ? state.defaultPersonaId : null
        }
      }
      state.selection[sid] = value
      save()
    } catch (e) {
      ctx.logger.warn('dsh-plugin-masterprompt: agent/created handler failed: ' + String((e && e.message) || e))
    }
  })

  // ---------- highest-priority prompt section ----------
  const offSection = ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (context) => {
      try {
        const sc = context && context.scope
        if (!sc) return ''
        let sid
        try {
          sid = typeof sc.id === 'string' ? sc.id : undefined
          if (!sid && sc.session && sc.session.header) sid = sc.session.header.id
        } catch {
          /* ignore */
        }
        if (typeof sid !== 'string' || !sid) return ''
        return renderPersona(sid)
      } catch {
        return ''
      }
    },
  })

  // ---------- HTTP API for the composer-box UI ----------
  function registerRoute(method, routePath, handler) {
    return ctx.webServer.register({
      kind: 'exact',
      path: routePath,
      handler: async (req, res) => {
        try {
          if (method === 'POST') {
            if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
          } else if (req.method !== method) {
            res.writeHead(405)
            res.end()
            return
          }
          await handler(req, res)
        } catch (e) {
          sendJson(res, 500, { ok: false, error: (e && e.message) || String(e) })
        }
      },
    })
  }

  ctx.effect(() => {
    const disposers = [
      registerRoute('GET', '/dsh-mp/state', (req, res) => {
        let sid = ''
        try {
          const u = new URL(req.url || '/', 'http://x')
          sid = u.searchParams.get('sid') || ''
        } catch {
          /* ignore */
        }
        const eff = sid ? effectiveTemplateId(sid) : null
        const effTemplate = eff ? templateOf(eff) : undefined
        const inUse = {}
        for (const t of state.templates) {
          let n = 0
          for (const k of Object.keys(state.selection)) if (state.selection[k] === t.id) n++
          inUse[t.id] = n
        }
        sendJson(res, 200, {
          ok: true,
          templates: state.templates,
          effective: effTemplate ? { id: effTemplate.id, name: effTemplate.name } : null,
          defaultPersonaId: state.defaultPersonaId || null,
          inUse,
        })
      }),
      registerRoute('POST', '/dsh-mp/save-template', async (req, res) => {
        const args = await readJsonBody(req)
        const nm = typeof args.name === 'string' ? args.name.trim() : ''
        const tx = typeof args.text === 'string' ? args.text : ''
        if (!nm || nm.length > MAX_TEMPLATE_NAME) return sendJson(res, 400, { ok: false, error: 'name required (1-100 chars)' })
        if (tx.length > MAX_TEMPLATE_TEXT) return sendJson(res, 400, { ok: false, error: 'text too long (max 100000 chars)' })
        if (typeof args.id === 'string' && args.id) {
          const t = templateOf(args.id)
          if (!t) return sendJson(res, 404, { ok: false, error: 'template not found' })
          t.name = nm
          t.text = tx
          t.updatedAt = now()
          save()
          return sendJson(res, 200, { ok: true, template: t })
        }
        const t = { id: newId(), name: nm, text: tx, createdAt: now(), updatedAt: now() }
        state.templates.push(t)
        save()
        return sendJson(res, 200, { ok: true, template: t })
      }),
      registerRoute('POST', '/dsh-mp/delete-template', async (req, res) => {
        const args = await readJsonBody(req)
        const id = args && typeof args.id === 'string' ? args.id : ''
        const idx = state.templates.findIndex((t) => t.id === id)
        if (idx < 0) return sendJson(res, 404, { ok: false, error: 'template not found' })
        let n = 0
        for (const k of Object.keys(state.selection)) if (state.selection[k] === id) n++
        if (n > 0) return sendJson(res, 409, { ok: false, error: 'in use by ' + n + ' conversation(s) - switch them first' })
        state.templates.splice(idx, 1)
        if (state.defaultPersonaId === id) state.defaultPersonaId = null
        save()
        return sendJson(res, 200, { ok: true })
      }),
      registerRoute('POST', '/dsh-mp/apply', async (req, res) => {
        const args = await readJsonBody(req)
        const sid = args && typeof args.sessionId === 'string' ? args.sessionId : ''
        const id = args && typeof args.templateId === 'string' ? args.templateId : ''
        if (!sid || sid.length > 200) return sendJson(res, 400, { ok: false, error: 'bad sessionId' })
        if (!templateOf(id)) return sendJson(res, 404, { ok: false, error: 'template not found' })
        state.selection[sid] = id
        state.defaultPersonaId = id
        save()
        return sendJson(res, 200, { ok: true })
      }),
      registerRoute('POST', '/dsh-mp/clear', async (req, res) => {
        const args = await readJsonBody(req)
        const sid = args && typeof args.sessionId === 'string' ? args.sessionId : ''
        if (!sid || sid.length > 200) return sendJson(res, 400, { ok: false, error: 'bad sessionId' })
        state.selection[sid] = null
        state.defaultPersonaId = null
        save()
        return sendJson(res, 200, { ok: true })
      }),
    ]
    return () => {
      for (const d of disposers) d()
    }
  }, 'dsh-plugin-masterprompt: http routes')

  return () => {
    offCreated()
    offSection()
  }
}
