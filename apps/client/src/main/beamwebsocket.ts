import { Transform, type TransformCallback } from "node:stream";
import {
  BEAM_MAX_BODY,
  BEAM_MAX_WEBSOCKET_FRAME,
  BEAM_MAX_WEBSOCKET_FRAGMENTS,
} from "./beamlimits";

// Only the RFC6455 header (at most 14 bytes) is retained. Payload slices pass
// through unchanged, preserving masking, ordering and stream backpressure.
// Compression/RSV extensions are deliberately unsupported in Beam v1.
export class BeamWebSocketValidator extends Transform {
  private readonly header = Buffer.alloc(14);
  private headerBytes = 0;
  private headerNeeded = 2;
  private remaining = 0;
  private fragmented = false;
  private messageBytes = 0;
  private fragments = 0;
  constructor(private readonly direction: "client" | "origin") {
    super();
  }

  private validateHeader(): number {
    const first = this.header[0],
      second = this.header[1];
    const fin = Boolean(first & 128),
      opcode = first & 15;
    if (
      first & 112 ||
      ![0, 1, 2, 8, 9, 10].includes(opcode) ||
      Boolean(second & 128) !== (this.direction === "client")
    )
      throw new Error("beam_websocket_protocol");
    let length = second & 127;
    if (length === 126) {
      length = this.header.readUInt16BE(2);
      if (length < 126) throw new Error("beam_websocket_protocol");
    } else if (length === 127) {
      const large = this.header.readBigUInt64BE(2);
      if (large < 65536n || large >> 63n)
        throw new Error("beam_websocket_protocol");
      if (large > BigInt(BEAM_MAX_WEBSOCKET_FRAME))
        throw new Error("beam_websocket_frame_limit");
      length = Number(large);
    }
    if (length > BEAM_MAX_WEBSOCKET_FRAME)
      throw new Error("beam_websocket_frame_limit");
    if (opcode >= 8) {
      if (!fin || length > 125 || (opcode === 8 && length === 1))
        throw new Error("beam_websocket_protocol");
      return length;
    }
    if (opcode === 0) {
      if (!this.fragmented) throw new Error("beam_websocket_protocol");
      this.messageBytes += length;
      this.fragments++;
    } else {
      if (this.fragmented) throw new Error("beam_websocket_protocol");
      this.messageBytes = length;
      this.fragments = 1;
    }
    if (this.messageBytes > BEAM_MAX_BODY)
      throw new Error("beam_websocket_message_limit");
    if (this.fragments > BEAM_MAX_WEBSOCKET_FRAGMENTS)
      throw new Error("beam_websocket_fragment_limit");
    this.fragmented = !fin;
    if (fin) {
      this.messageBytes = 0;
      this.fragments = 0;
    }
    return length;
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.remaining) {
          const count = Math.min(this.remaining, chunk.length - offset);
          this.push(chunk.subarray(offset, offset + count));
          offset += count;
          this.remaining -= count;
          continue;
        }
        const count = Math.min(
          this.headerNeeded - this.headerBytes,
          chunk.length - offset,
        );
        chunk.copy(this.header, this.headerBytes, offset, offset + count);
        this.headerBytes += count;
        offset += count;
        if (this.headerBytes < this.headerNeeded) continue;
        if (this.headerNeeded === 2) {
          const size = this.header[1] & 127;
          this.headerNeeded =
            2 +
            (size === 126 ? 2 : size === 127 ? 8 : 0) +
            (this.header[1] & 128 ? 4 : 0);
          if (this.headerBytes < this.headerNeeded) continue;
        }
        this.remaining = this.validateHeader();
        // Copy only the tiny header because its scratch storage is reused.
        this.push(Buffer.from(this.header.subarray(0, this.headerNeeded)));
        this.headerBytes = 0;
        this.headerNeeded = 2;
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    callback(
      this.headerBytes || this.remaining
        ? new Error("beam_websocket_truncated")
        : null,
    );
  }
}
