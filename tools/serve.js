// 开发用静态文件服务器：node tools/serve.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = parseInt(process.argv[2], 10) || 8791;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.md': 'text/plain; charset=utf-8'
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let filePath = path.join(root, urlPath === '/' ? 'test/harness.html' : urlPath);
    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('not found: ' + urlPath);
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(data);
    });
  })
  .listen(port, '127.0.0.1', () => console.log(`serving ${root} at http://127.0.0.1:${port}/`));
