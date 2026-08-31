import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';

export interface ComfyMockOptions {
  fail?: boolean;
  completionDelayMs?: number;
  outputFilename?: string;
  outputBytes?: Uint8Array;
}

export interface ComfyMock {
  url: string;
  lastPromptId: () => string | null;
  /** The full `{ prompt, client_id }` body of the most recent POST /prompt — lets
   *  tests assert on the actual patched workflow JSON rather than network I/O. */
  lastPrompt: () => { prompt: Record<string, { inputs?: Record<string, unknown> }> } | null;
  setOptions: (opts: ComfyMockOptions) => void;
  close: () => Promise<void>;
}

export function startComfyMock(): Promise<ComfyMock> {
  return new Promise((resolve) => {
    let opts: ComfyMockOptions = {};
    let lastPromptId: string | null = null;
    let lastPrompt: { prompt: Record<string, { inputs?: Record<string, unknown> }> } | null = null;
    // Monotonic counter (not Date.now()) so two uploads racing in the same
    // Promise.all in the same millisecond still get distinguishable filenames.
    let uploadSeq = 0;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/system_stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ system: { python_version: '3.10' } }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/prompt') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          try {
            lastPrompt = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            lastPrompt = null;
          }
          const promptId = `mock-prompt-${Date.now()}`;
          lastPromptId = promptId;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ prompt_id: promptId }));

          const delayMs = opts.completionDelayMs ?? 50;
          setTimeout(() => {
            wss.clients.forEach((ws) => {
              const event = opts.fail
                ? {
                    type: 'execution_error',
                    data: { prompt_id: promptId, exception_message: 'mock error' },
                  }
                : { type: 'execution_complete', data: { prompt_id: promptId } };
              if (ws.readyState === 1) ws.send(JSON.stringify(event));
            });
          }, delayMs);
        });
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/history/')) {
        const promptId = url.pathname.split('/').pop() ?? '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (opts.fail) {
          // waitForCompletion (src/comfyui/progress.ts) polls this endpoint and
          // fails a job only on status.status_str === 'error' — it does not
          // consult the /prompt websocket event above, so that's the shape
          // ComfyMockOptions.fail must produce here to actually force a failure.
          res.end(
            JSON.stringify({
              [promptId]: {
                status: {
                  status_str: 'error',
                  messages: [
                    [
                      'execution_error',
                      { node_type: 'MockNode', node_id: '1', exception_message: 'mock error' },
                    ],
                  ],
                },
              },
            }),
          );
          return;
        }
        const filename = opts.outputFilename ?? 'result.png';
        res.end(
          JSON.stringify({
            [promptId]: {
              outputs: { '10': { images: [{ filename, subfolder: '', type: 'output' }] } },
            },
          }),
        );
        return;
      }

      if (req.method === 'POST' && url.pathname === '/upload/image') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          // Echo the incoming multipart field's original filename (e.g.
          // "shopify_customer_<jobId>.jpg") back into the assigned name so
          // tests can trace the returned name to its source upload instead of
          // getting an arbitrary counter-only string. `uploadSeq` is still
          // appended to preserve collision-avoidance for callers that upload
          // multiple files with the same prefix/name in one job.
          const body = Buffer.concat(chunks).toString('utf8');
          const match = body.match(/filename="([^"]*)"/);
          const originalName = match?.[1] ?? 'unknown';
          const stem = originalName.replace(/\.[^./]+$/, '') || 'unknown';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ name: `uploaded-${stem}-${uploadSeq++}.jpg` }));
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/view') {
        // PNG magic bytes as minimal valid response
        const bytes = opts.outputBytes ?? new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(Buffer.from(bytes));
        return;
      }

      res.writeHead(404).end();
    });

    const wss = new WebSocketServer({ server });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        lastPromptId: () => lastPromptId,
        lastPrompt: () => lastPrompt,
        setOptions: (newOpts) => {
          opts = newOpts;
        },
        close: () =>
          new Promise<void>((r) => {
            wss.close();
            server.close(() => r());
          }),
      });
    });
  });
}
