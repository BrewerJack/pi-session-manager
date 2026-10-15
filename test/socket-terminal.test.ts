import assert from "node:assert/strict";
import { test } from "node:test";
import { setKittyProtocolActive, StdinBuffer } from "@earendil-works/pi-tui";
import { parseNegotiation, SocketTerminal } from "../socket-terminal.ts";

const KITTY_QUERY = "\x1b[>7u\x1b[?u\x1b[c";

function setup() {
	const kittyCalls: boolean[] = [];
	const terminal = new SocketTerminal({
		StdinBuffer,
		setKittyProtocolActive: (active) => {
			kittyCalls.push(active);
			setKittyProtocolActive(active);
		},
	});
	const written: string[] = [];
	const input: string[] = [];
	let resized = 0;
	const attach = (columns = 100, rows = 30) => terminal.attach((data) => written.push(data), { columns, rows });
	const start = () =>
		terminal.start(
			(data) => input.push(data),
			() => resized++,
		);
	return { terminal, written, input, kittyCalls, attach, start, resizes: () => resized };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

test("parseNegotiation reads Kitty flags and device attributes", () => {
	assert.deepEqual(parseNegotiation("\x1b[?7u"), { type: "kitty-flags", flags: 7 });
	assert.deepEqual(parseNegotiation("\x1b[?62;22c"), { type: "device-attributes" });
	assert.equal(parseNegotiation("\x1b[A"), undefined);
});

test("output is dropped while no client holds the terminal", () => {
	const { terminal, written, start } = setup();
	start();
	terminal.write("hidden");
	terminal.clearScreen();
	assert.deepEqual(written, []);
});

test("start negotiates with the client, and a Kitty reply turns the protocol on", async () => {
	const { terminal, written, input, kittyCalls, attach, start } = setup();
	attach();
	start();
	assert.equal(written.join(""), `\x1b[?2004h${KITTY_QUERY}`);
	terminal.input("\x1b[?7u");
	terminal.input("\x1b[?62;22c");
	await settle();
	assert.equal(terminal.kittyProtocolActive, true);
	assert.deepEqual(kittyCalls, [true]);
	assert.deepEqual(input, [], "negotiation replies are not keys");
	terminal.stop();
	assert.ok(written.join("").endsWith("\x1b[?2004l\x1b[<u"));
	assert.equal(terminal.kittyProtocolActive, false);
	assert.deepEqual(kittyCalls, [true, false]);
});

test("device attributes without a Kitty reply turn modifyOtherKeys on", async () => {
	const { terminal, written, attach, start } = setup();
	attach();
	start();
	terminal.input("\x1b[?1;2c");
	await settle();
	assert.equal(terminal.modifyOtherKeysActive, true);
	assert.ok(written.includes("\x1b[>4;2m"));
	terminal.stop();
	assert.ok(written.join("").endsWith("\x1b[>4;0m"));
});

test("a later device-attributes reply reaches the input handler", async () => {
	const { terminal, input, attach, start } = setup();
	attach();
	start();
	terminal.input("\x1b[?1;2c");
	await settle();
	terminal.input("\x1b[?1;2c");
	await settle();
	assert.deepEqual(input, ["\x1b[?1;2c"]);
});

test("keys and pastes reach the input handler", async () => {
	const { terminal, input, attach, start } = setup();
	attach();
	start();
	terminal.input("a\x1b[A");
	terminal.input("\x1b[200~pasted\ntext\x1b[201~");
	await settle();
	assert.deepEqual(input, ["a", "\x1b[A", "\x1b[200~pasted\ntext\x1b[201~"]);
});

test("resize updates the size and calls the resize handler", () => {
	const { terminal, attach, start, resizes } = setup();
	attach(80, 24);
	start();
	terminal.resize({ columns: 132, rows: 50 });
	assert.equal(terminal.columns, 132);
	assert.equal(terminal.rows, 50);
	assert.equal(resizes(), 1);
});

test("the title comes back on the next attach", () => {
	const { terminal, written, attach } = setup();
	terminal.setTitle("pi - app");
	assert.deepEqual(written, []);
	attach();
	assert.deepEqual(written, ["\x1b]0;pi - app\x07"]);
});

test("detach resets the keyboard state for the next client", async () => {
	const { terminal, attach, start } = setup();
	attach();
	start();
	terminal.input("\x1b[?7u");
	await settle();
	assert.equal(terminal.kittyProtocolActive, true);
	terminal.stop();
	terminal.detach();
	assert.equal(terminal.attached, false);
	assert.equal(terminal.kittyProtocolActive, false);
});
