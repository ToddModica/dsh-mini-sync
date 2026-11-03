// Minimal WebDAV-ish server for testing dsh-mini-sync: PUT / GET / MKCOL / DELETE / PROPFIND.
// Not a production server — only enough surface to exercise the plugin's sync path.
import http from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const ROOT = process.argv[2] || './dav-root'
const PORT = Number(process.argv[3] || 18080)

const abs = (urlPath) => {
  const clean = decodeURIComponent(urlPath.split('?')[0]).replace(/\.\./g, '')
  return path.join(ROOT, clean)
}

const isDir = async (p) => {
  try { return (await fs.stat(p)).isDirectory() } catch { return false }
}

const server = http.createServer(async (req, res) => {
  const target = abs(req.url)
  try {
    if (req.method === 'MKCOL') {
      if (await isDir(target)) { res.writeHead(405).end(); return }
      // Real servers answer 409 when the parent collection is absent, which is
      // exactly the case a one-level MKCOL would fail on.
      const parent = path.dirname(target)
      if (!(await isDir(parent))) { res.writeHead(409).end(); return }
      try { await fs.mkdir(target); res.writeHead(201).end() }
      catch { res.writeHead(409).end() }
      return
    }
    if (req.method === 'PUT') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, Buffer.concat(chunks))
      res.writeHead(201).end()
      return
    }
    if (req.method === 'GET') {
      try {
        const body = await fs.readFile(target)
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(body)
      } catch { res.writeHead(404).end() }
      return
    }
    if (req.method === 'DELETE') {
      try { await fs.rm(target, { recursive: true }); res.writeHead(204).end() }
      catch { res.writeHead(404).end() }
      return
    }
    if (req.method === 'PROPFIND') {
      if (!(await isDir(target))) { res.writeHead(404).end(); return }
      const names = await fs.readdir(target)
      const hrefs = names.map((n) => `<d:response><d:href>${req.url.replace(/\/$/, '')}/${encodeURIComponent(n)}</d:href></d:response>`)
      res.writeHead(207, { 'Content-Type': 'application/xml' })
        .end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${hrefs.join('')}</d:multistatus>`)
      return
    }
    res.writeHead(405).end()
  } catch (error) {
    res.writeHead(500).end(String(error))
  }
})

server.listen(PORT, '127.0.0.1', () => console.log(`dav test server on http://127.0.0.1:${PORT} root=${ROOT}`))