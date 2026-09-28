/**
 * Turns byte chunks into complete text lines. A chunk may end mid-line or mid-character (the client flushes
 * its buffer whenever it likes), so the tail is held until the rest arrives.
 */
export class LineSplitter {
  private decoder = new TextDecoder("utf-8");
  private buffer = "";

  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.takeLines();
  }

  pushText(text: string): string[] {
    this.buffer += text;
    return this.takeLines();
  }

  /** Text received after the last newline. */
  get pending(): string {
    return this.buffer;
  }

  /** Ends the stream: the unterminated tail, if any, becomes the last line. */
  flush(): string[] {
    this.buffer += this.decoder.decode();
    const rest = this.buffer;
    this.reset();
    return rest.length > 0 ? [rest] : [];
  }

  /** Drops any partial line, for when the file underneath was truncated or replaced. */
  reset() {
    this.decoder = new TextDecoder("utf-8");
    this.buffer = "";
  }

  private takeLines(): string[] {
    const lines: string[] = [];
    let start = 0;
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      lines.push(this.buffer.slice(start, nl));
      start = nl + 1;
      nl = this.buffer.indexOf("\n", start);
    }
    if (start > 0) this.buffer = this.buffer.slice(start);
    return lines;
  }
}

/**
 * Read a byte stream as text lines without holding the whole file. `onProgress` receives bytes read so far,
 * so a caller that knows the file size can show a percentage.
 */
export async function* readLines(
  stream: ReadableStream<Uint8Array>,
  onProgress?: (bytesRead: number) => void,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const splitter = new LineSplitter();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      yield* splitter.push(value);
      onProgress?.(bytes);
    }
    yield* splitter.flush();
  } finally {
    reader.releaseLock();
  }
}

export function* splitLines(text: string): Generator<string> {
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      if (start < text.length) yield text.slice(start);
      return;
    }
    yield text.slice(start, nl);
    start = nl + 1;
  }
}
