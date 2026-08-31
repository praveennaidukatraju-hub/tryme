import { createServer } from 'node:http';
import type { Logger } from '@tryme/logger';
import { metricsContentType, metricsText } from '@tryme/observability';

export function startHealthServer(port: number, log: Logger): () => void {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } else if (req.method === 'GET' && req.url === '/metrics') {
      metricsText()
        .then((body) => {
          res.writeHead(200, { 'Content-Type': metricsContentType });
          res.end(body);
        })
        .catch((err) => {
          log.error({ err }, 'failed to render metrics');
          res.writeHead(500).end();
        });
    } else {
      res.writeHead(404).end();
    }
  });

  // Bind 0.0.0.0 so the Alloy agent can scrape dispatcher:PORT/metrics over the
  // Docker network. No public port mapping is added in compose, so this stays off
  // the internet — reachable only from sibling containers on tryme-net.
  server.listen(port, '0.0.0.0', () => {
    log.info({ port }, 'health server listening');
  });

  return () => server.close();
}
