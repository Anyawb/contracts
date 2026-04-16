/**
 * Make deploy logs stable and non-noisy across terminals.
 *
 * Problem we solve:
 * - Some dependencies (spinners/progress bars) write `\r` (carriage return) to redraw the same line.
 * - Many terminal recorders (and some IDE terminal captures) will persist both the "old" and "new" line,
 *   making it look like every log line is duplicated or truncated.
 *
 * Strategy:
 * - Filter out "redraw frames" that contain `\r` but no newline.
 * - For mixed content, strip `\r` to avoid overwriting effects.
 * - Also set common env flags to disable interactive behavior where possible.
 *
 * This is NOT "deleting logs" — it prevents redraw-style output from ever being emitted.
 */
export function initStableDeploymentOutput(): void {
  // Best-effort: encourage non-interactive logging in dependencies.
  process.env.CI ||= '1';
  process.env.NO_COLOR ||= '1';
  process.env.FORCE_COLOR ||= '0';

  const wrap = (write: any) => {
    return function (chunk: any, encoding?: any, cb?: any) {
      try {
        const str =
          typeof chunk === 'string'
            ? chunk
            : Buffer.isBuffer(chunk)
              ? chunk.toString(typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8')
              : String(chunk);

        // Drop redraw frames (spinner/progress updates) that do not end a line.
        if (str.includes('\r') && !str.includes('\n')) {
          return true;
        }

        // Prevent overwrite semantics in captured logs.
        const cleaned = str.replace(/\r/g, '');
        const normalizedEncoding = typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined;
        return write(cleaned, normalizedEncoding, cb);
      } catch {
        return write(chunk, encoding, cb);
      }
    };
  };

  // Patch both stdout and stderr: spinners/progress may write to either.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = wrap((process.stdout as any).write.bind(process.stdout));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = wrap((process.stderr as any).write.bind(process.stderr));
}

