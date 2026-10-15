import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFrame, encodeJsonFrame, FrameDecoder, FrameType, parseJson } from "../protocol.ts";

test("frames round-trip, also when the stream splits them at every byte", () => {
	const frames = [
		encodeFrame(FrameType.data, "abc\x1b[2J"),
		encodeJsonFrame(FrameType.resize, { columns: 120, rows: 40 }),
		encodeFrame(FrameType.data, Buffer.alloc(0)),
	];
	const stream = Buffer.concat(frames);
	const decoder = new FrameDecoder();
	const out = [];
	for (const byte of stream) out.push(...decoder.push(Buffer.from([byte])));
	assert.equal(out.length, 3);
	assert.equal(out[0]?.type, FrameType.data);
	assert.equal(out[0]?.payload.toString("utf8"), "abc\x1b[2J");
	assert.deepEqual(parseJson(out[1]!), { columns: 120, rows: 40 });
	assert.equal(out[2]?.payload.length, 0);
});

test("a payload with U+2028 and U+2029 stays one frame", () => {
	const text = "line\u2028separator\u2029paragraph\n";
	const decoder = new FrameDecoder();
	const out = decoder.push(encodeFrame(FrameType.data, text));
	assert.equal(out.length, 1);
	assert.equal(out[0]?.payload.toString("utf8"), text);
});

test("a multi-byte character split across chunks survives", () => {
	const frame = encodeFrame(FrameType.data, "✓ done");
	const decoder = new FrameDecoder();
	assert.deepEqual(decoder.push(frame.subarray(0, 6)), []);
	const out = decoder.push(frame.subarray(6));
	assert.equal(out[0]?.payload.toString("utf8"), "✓ done");
});

test("an oversized length throws", () => {
	const header = Buffer.from([FrameType.data, 0xff, 0xff, 0xff, 0xff]);
	assert.throws(() => new FrameDecoder().push(header), /exceeds the limit/);
});

test("broken JSON gives undefined", () => {
	const [frame] = new FrameDecoder().push(encodeFrame(FrameType.hello, "{not json"));
	assert.equal(parseJson(frame!), undefined);
});
