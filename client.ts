// Attach client: gives the real terminal to a worker. It ends when the worker detaches
// the client, the connection closes, or the worker switches the client to another session.
import net from "node:net";
import {
	encodeFrame,
	encodeJsonFrame,
	FrameDecoder,
	FrameType,
	parseJson,
	PROTOCOL_VERSION,
	type AttachHello,
	type Detached,
} from "./protocol.ts";

export type AttachResult =
	| { kind: "detached"; detached: Detached }
	| { kind: "switch"; id: string }
	| { kind: "closed" }
	| { kind: "error"; message: string };

/** Escape sequences that turn off the modes of a worker that died without a stop. */
const TERMINAL_RESET = "\x1b[?2004l\x1b[<u\x1b[>4;0m\x1b[?2031l\x1b[?25h\r\n";

export interface AttachStreams {
	input: NodeJS.ReadStream;
	output: NodeJS.WriteStream;
}

export function attach(
	socketPath: string,
	streams: AttachStreams = { input: process.stdin, output: process.stdout },
): Promise<AttachResult> {
	const { input, output } = streams;
	return new Promise((resolve) => {
		const socket = net.connect(socketPath);
		const decoder = new FrameDecoder();
		const wasRaw = input.isRaw ?? false;
		let result: AttachResult | undefined;
		let started = false;

		const onInput = (chunk: Buffer | string) => {
			if (!socket.destroyed) socket.write(encodeFrame(FrameType.data, Buffer.from(chunk)));
		};
		const onResize = () => {
			socket.write(encodeJsonFrame(FrameType.resize, { columns: output.columns, rows: output.rows }));
		};
		const finish = (fallback: AttachResult) => {
			if (started) {
				input.off("data", onInput);
				output.off("resize", onResize);
				input.pause();
				input.setRawMode?.(wasRaw);
			}
			// A clean detach restores the terminal. After any other end, modes can stay on.
			const final = result ?? fallback;
			if (started && final.kind !== "detached" && final.kind !== "switch") output.write(TERMINAL_RESET);
			resolve(final);
		};

		socket.once("connect", () => {
			started = true;
			const hello: AttachHello = {
				version: PROTOCOL_VERSION,
				columns: output.columns || 80,
				rows: output.rows || 24,
				term: process.env.TERM,
				colorterm: process.env.COLORTERM,
				termProgram: process.env.TERM_PROGRAM,
			};
			socket.write(encodeJsonFrame(FrameType.hello, hello));
			input.setRawMode?.(true);
			input.resume();
			input.on("data", onInput);
			output.on("resize", onResize);
		});
		socket.on("data", (chunk: Buffer) => {
			let frames;
			try {
				frames = decoder.push(chunk);
			} catch (error) {
				result = { kind: "error", message: String(error) };
				socket.destroy();
				return;
			}
			for (const frame of frames) {
				if (frame.type === FrameType.data) {
					output.write(frame.payload);
				} else if (frame.type === FrameType.detached) {
					result = { kind: "detached", detached: parseJson<Detached>(frame) ?? { reason: "error" } };
				} else if (frame.type === FrameType.switch) {
					const target = parseJson<{ id: string }>(frame);
					if (target?.id) result = { kind: "switch", id: target.id };
				}
			}
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			result ??= { kind: "error", message: error.code === "ENOENT" ? "The session has no worker." : error.message };
		});
		socket.once("close", () => finish({ kind: "closed" }));
	});
}
