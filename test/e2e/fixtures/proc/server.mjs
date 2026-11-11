// A background-process stand-in: HTTP on the port given, a tick line every 200 ms (the log grows), and
// GET /exit?code=N ends the process with that code (a process that ends by itself).
import { createServer } from 'node:http'
const port = Number(process.argv[2] ?? 0)
let n = 0
setInterval(() => console.log(`tick ${++n}`), 200)
createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/exit') {
    res.end('bye\n')
    console.log(`saindo com ${url.searchParams.get('code')}`)
    setTimeout(() => process.exit(Number(url.searchParams.get('code') ?? 0)), 50)
    return
  }
  res.end(`ok ${process.pid}\n`)
}).listen(port, '127.0.0.1', () => console.log(`listening ${port}`))
