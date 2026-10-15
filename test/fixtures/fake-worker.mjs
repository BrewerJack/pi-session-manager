// A stand-in for worker.ts in supervisor tests. It speaks the control protocol only.
// Usage: node fake-worker.mjs <supervisor socket> <id> [session file]
// FAKE_STATE sets the reported state. The worker reconnects every 100 ms after a loss.
// It answers send and rename with an update, as a real worker does, and transcript with one item.
// FAKE_ATTACHED reports a client that holds the session.
import net from "node:net";

const [socketPath, id, sessionFile] = process.argv.slice(2);
const state = process.env.FAKE_STATE || "idle";
let nextId = 1;

function connect() {
	const socket = net.connect(socketPath);
	let buffer = "";
	socket.on("connect", () => {
		const update = { state, ...(sessionFile ? { sessionFile } : {}), ...(process.env.FAKE_ATTACHED ? { attached: true } : {}) };
		socket.write(`${JSON.stringify({ type: "worker.hello", id: nextId++, workerId: id, pid: process.pid, update })}\n`);
	});
	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const message = JSON.parse(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			const reply = (data) => socket.write(`${JSON.stringify({ type: "response", id: message.id, ok: true, data })}\n`);
			const update = (fields) => socket.write(`${JSON.stringify({ type: "worker.update", update: fields })}\n`);
			if (message.type === "stop") {
				reply({});
				setTimeout(() => process.exit(0), 20);
			} else if (message.type === "send") {
				reply({});
				update({ lastPrompt: message.text });
			} else if (message.type === "rename") {
				reply({});
				update({ name: message.name });
			} else if (message.type === "transcript") {
				reply({ items: [{ kind: "user", text: "from the worker" }] });
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
