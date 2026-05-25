import { NextRequest } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Force Node.js runtime — this route uses node:fs which is not available in
// the Edge runtime.
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitise a caller-supplied taskId so it cannot escape the log directory via
 * path traversal (e.g. `../../etc/passwd`). `path.basename` strips any
 * leading directory components while keeping the final segment intact.
 */
function sanitiseId(raw: string): string {
  return path.basename(raw);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// GET /api/agents/[taskId]/stream
// ---------------------------------------------------------------------------

/**
 * Server-Sent Events endpoint that tails the agent log file for a given task.
 *
 * - Sends existing file content immediately on connect (catch-up).
 * - Polls for new bytes every 500 ms (log growth).
 * - Polls for the done-file every 2 s; when found, emits `event: done` and
 *   closes the stream.
 * - Cleans up all timers on client disconnect (req.signal abort).
 *
 * Log path: `{FORGE_WORKDIR}/context/agent-logs/{taskId}.log`
 * Done path: `{FORGE_WORKDIR}/.forge/tasks/{taskId}.done`
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  const { taskId: rawId } = await params;
  const taskId = sanitiseId(rawId);

  const workdir = process.env['FORGE_WORKDIR'] ?? process.cwd();
  const logPath = path.join(workdir, 'context', 'agent-logs', `${taskId}.log`);
  const donePath = path.join(workdir, '.forge', 'tasks', `${taskId}.done`);

  const encoder = new TextEncoder();

  // Mutable state shared across start / cancel / abort handler.
  let offset = 0;
  let logTimer: ReturnType<typeof setInterval> | null = null;
  let doneTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // ------------------------------------------------------------------
      // Helpers
      // ------------------------------------------------------------------

      function enqueue(text: string): void {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // controller already closed — ignore
        }
      }

      function close(): void {
        if (closed) return;
        closed = true;
        if (logTimer !== null) { clearInterval(logTimer); logTimer = null; }
        if (doneTimer !== null) { clearInterval(doneTimer); doneTimer = null; }
        try { controller.close(); } catch { /* already closed */ }
      }

      async function readNewBytes(): Promise<void> {
        try {
          const stat = await fs.stat(logPath);
          if (stat.size <= offset) return;

          const len = stat.size - offset;
          const buf = Buffer.alloc(len);
          const fh = await fs.open(logPath, 'r');
          try {
            await fh.read(buf, 0, len, offset);
          } finally {
            await fh.close();
          }
          offset = stat.size;

          // Emit each non-empty line as a separate SSE data event so the
          // client receives individual log lines rather than a single large
          // blob. Empty lines (blank separators in the log) are skipped.
          const text = buf.toString('utf8');
          for (const line of text.split('\n')) {
            if (line.length > 0) {
              enqueue(`data: ${line}\n\n`);
            }
          }
        } catch {
          // Log file doesn't exist yet or transient read error — retry next tick.
        }
      }

      async function checkDone(): Promise<void> {
        if (await fileExists(donePath)) {
          enqueue('event: done\ndata: {}\n\n');
          close();
        }
      }

      // ------------------------------------------------------------------
      // Abort handler — fires when the client disconnects.
      // ------------------------------------------------------------------
      req.signal.addEventListener('abort', () => { close(); });

      // ------------------------------------------------------------------
      // Main startup sequence
      // ------------------------------------------------------------------

      // 1. Check if already completed before starting timers.
      await checkDone();
      if (closed) return;

      // 2. Send any existing log content (catch-up for reconnects).
      await readNewBytes();

      // 3. Poll for new bytes every 500 ms.
      logTimer = setInterval(async () => {
        if (closed) return;
        await readNewBytes();
      }, 500);

      // 4. Poll for the done file every 2 s.
      doneTimer = setInterval(async () => {
        if (closed) return;
        await checkDone();
      }, 2000);
    },

    cancel(): void {
      // Called when the downstream consumer cancels the stream (e.g. response
      // body drained or connection dropped at the HTTP layer before the abort
      // signal fires). Belt-and-suspenders cleanup.
      closed = true;
      if (logTimer !== null) { clearInterval(logTimer); logTimer = null; }
      if (doneTimer !== null) { clearInterval(doneTimer); doneTimer = null; }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      // Tell nginx/proxies not to buffer SSE frames.
      'X-Accel-Buffering': 'no',
    },
  });
}
