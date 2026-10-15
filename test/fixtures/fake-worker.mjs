// A stand-in for worker.ts in supervisor tests. It speaks the control protocol only.
// Usage: node fake-worker.mjs <supervisor socket> <id> [session file]
// FAKE_STATE sets the reported state. The worker reconnects every 100 ms after a loss.
import net from "node:net";

const [socketPath, id, sessionFile] = process.argv.slice(2);
const state = process.env.FAKE_STATE || "idle";
let nextId = 1;

function connect() {
	const socket = net.connect(socketPath);
	let buffer = "";
	socket.on("connect", () => {
		const update = { state, ...(sessionFile ? { sessionFile } : {}) };
		socket.write(`${JSON.stringify({ type: "worker.hello", id: nextId++, workerId: id, pid: process.pid, update })}\n`);
	});
	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const message = JSON.parse(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			if (message.type === "stop") {
				socket.write(`${JSON.stringify({ type: "response", id: message.id, ok: true, data: {} })}\n`);
				setTimeout(() => process.exit(0), 20);
			}
			if (message.type === "response" && !message.ok) process.exit(3);
			newline = buffer.indexOf("\n");
		}
	});
	socket.on("error", () => {});
	socket.on("close", () => setTimeout(connect, 100));
}

process.on("SIGTERM", () => process.exit(0));
connect();
