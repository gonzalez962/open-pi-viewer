import { DEFAULT_MAX_REPLAY_BYTES } from './types';

export class BoundedBuffer {
  private chunks: string[] = [];
  private totalLength = 0;
  private droppedOffset = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number = DEFAULT_MAX_REPLAY_BYTES) {
    this.maxBytes = Math.max(1024, maxBytes);
  }

  append(data: string): void {
    if (!data) return;
    this.chunks.push(data);
    this.totalLength += data.length;

    // Prune chunks if total length exceeds maxBytes
    while (this.totalLength > this.maxBytes && this.chunks.length > 0) {
      const first = this.chunks[0];
      const overflow = this.totalLength - this.maxBytes;
      if (first.length <= overflow) {
        this.totalLength -= first.length;
        this.droppedOffset += first.length;
        this.chunks.shift();
      } else {
        // Slice the first chunk
        this.chunks[0] = first.slice(overflow);
        this.totalLength -= overflow;
        this.droppedOffset += overflow;
        break;
      }
    }
  }

  getHeadCursor(): number {
    return this.droppedOffset + this.totalLength;
  }

  getTailCursor(): number {
    return this.droppedOffset;
  }

  readFrom(cursor: number = 0): { data: string; nextCursor: number } {
    const head = this.getHeadCursor();
    if (cursor >= head) {
      return { data: '', nextCursor: head };
    }

    const fullStr = this.toString();
    const effectiveStart = Math.max(0, cursor - this.droppedOffset);
    const data = fullStr.slice(effectiveStart);
    return { data, nextCursor: head };
  }

  toString(): string {
    return this.chunks.join('');
  }

  clear(): void {
    this.chunks = [];
    this.totalLength = 0;
    this.droppedOffset = 0;
  }
}
