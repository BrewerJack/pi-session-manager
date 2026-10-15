// Wire format between an attach client and a worker: [type: u8][length: u32 BE][payload].
// JSON payloads are UTF-8. Terminal bytes travel as they are.

export const FrameType = {
	/** client → worker: AttachHello as JSON. Must be the first frame. */
	hello: 0,
	/** both ways: terminal bytes */
	data: 1,
	/** client → worker: TerminalSize as JSON */
	resize: 2,
	/** worker → client: Detached as JSON. The worker closes the connection after it. */
	detached: 3,
	/** worker → client: { id } as JSON. The client attaches to that session next. */
	switch: 4,
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

export interface TerminalSize {
	columns: number;
	rows: number;
}

export interface AttachHello extends TerminalSize {
	version: number;
	term?: string;
	colorterm?: string;
	termProgram?: string;
}

export type DetachReason = "quit" | "taken" | "stopped" | "error";

export interface Detached {
	reason: DetachReason;
	message?: string;
}

export interface Frame {
	type: number;
	payload: Buffer;
}

export const PROTOCOL_VERSION = 1;
const HEADER_BYTES = 5;
/** A frame larger than this means a broken peer. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function encodeFrame(type: FrameTypeValue, payload: string | Buffer = Buffer.alloc(0)): Buffer {
	const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
	const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length);
	frame.writeUInt8(type, 0);
	frame.writeUInt32BE(body.length, 1);
	body.copy(frame, HEADER_BYTES);
	return frame;
}

export function encodeJsonFrame(type: FrameTypeValue, value: unknown): Buffer {
	return encodeFrame(type, JSON.stringify(value));
}

export function parseJson<T>(frame: Frame): T | undefined {
	try {
		return JSON.parse(frame.payload.toString("utf8")) as T;
	} catch {
		return undefined;
	}
}

/** Collects stream chunks and returns the complete frames in them. */
export class FrameDecoder {
	private buffer: Buffer = Buffer.alloc(0);

	push(chunk: Buffer): Frame[] {
		this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
		const frames: Frame[] = [];
		while (this.buffer.length >= HEADER_BYTES) {
			const length = this.buffer.readUInt32BE(1);
			if (length > MAX_FRAME_BYTES) throw new Error(`Frame of ${length} bytes exceeds the limit`);
			if (this.buffer.length < HEADER_BYTES + length) break;
			frames.push({
				type: this.buffer.readUInt8(0),
				payload: Buffer.from(this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length)),
			});
			this.buffer = this.buffer.subarray(HEADER_BYTES + length);
		}
		return frames;
	}
}
