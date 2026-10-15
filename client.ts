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
	/** Drops the connection without a detach, as a closed terminal does. */
	signal?: AbortSignal;
	/** Changes input before it goes to the worker, such as the macOS Option key. */
	translate?: (data: string) => string;
}

const STANDARD_STREAMS: AttachStreams = { input: process.stdin, output: process.stdout };

export function attach(socketPath: string, streams: AttachStreams = STANDARD_STREAMS): Promise<AttachResult> {
	const { input, output, signal, translate } = streams;
	return new Promise((resolve) => {
		const socket = net.connect(socketPath);
		const abort = () => socket.destroy();
		if (signal?.aborted) abort();
		signal?.addEventListener("abort", abort, { once: true });
		const decoder = new FrameDecoder();
		const wasRaw = input.isRaw ?? false;
		let result: AttachResult | undefined;
		let started = false;

		const onInput = (chunk: Buffer | string) => {
			if (socket.destroyed) return;
			const data = translate ? Buffer.from(translate(chunk.toString())) : Buffer.from(chunk);
			socket.write(encodeFrame(FrameType.data, data));
		};
		const onResize = () => {
			socket.write(encodeJsonFrame(FrameType.resize, { columns: output.columns, rows: output.rows }));
		};
		const finish = (fallback: AttachResult) => {
			signal?.removeEventListener("abort", abort);
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
					// A switch comes with a detach. The switch wins.
					if (result?.kind !== "switch") {
						result = { kind: "detached", detached: parseJson<Detached>(frame) ?? { reason: "error" } };
					}
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

/** Finds the worker socket of a session. A saved session starts first. */
export type Resolve = (id: string) => Promise<{ id: string; socket: string }>;

/**
 * Attach to a session, and follow the switches that the manager inside a session sends.
 * Returns how the last attach ended, and the id of the last session.
 */
export async function attachLoop(
	resolve: Resolve,
	id: string,
	streams?: AttachStreams,
): Promise<{ result: AttachResult; id: string }> {
	let target = id;
	for (let hops = 0; hops < 100; hops++) {
		const found = await resolve(target);
		const result = await attach(found.socket, streams);
		if (result.kind !== "switch") return { result, id: found.id };
		target = result.id;
	}
	return { result: { kind: "error", message: "Too many switches in a row." }, id: target };
}

/** What the user reads after an attach ends. `again` is the command that attaches once more. */
export function describeEnd(result: AttachResult, id: string, again = `pi-sm attach ${id}`): string {
	if (result.kind === "error") return result.message;
	if (result.kind === "detached") {
		const { reason, message } = result.detached;
		if (reason === "stopped") return `The session ${id} stopped.${message ? ` ${message}` : ""}`;
		if (reason === "taken") return `Another terminal took over the session. Run "${again}" to take it back.`;
		if (reason === "error") return `The session ${id} sent this terminal away${message ? `: ${message}` : "."}`;
	}
	return `Detached. The session keeps running. Run "${again}" to come back.`;
}

