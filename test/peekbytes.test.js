/**
 * peekBytes underpins the streaming upload: the Worker has to check a .deb's
 * ar magic without buffering the file, so it reads the first few bytes and then
 * forwards a stream that must still yield the *complete* original sequence.
 * Dropping or duplicating a byte here would corrupt every uploaded package.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { peekBytes } from "../worker/src/index.js";

/** A stream that hands out exactly the given chunks, to pin down boundaries. */
function streamOf(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(Uint8Array.from(c));
      controller.close();
    },
  });
}

async function drain(stream) {
  const out = [];
  for await (const chunk of stream) out.push(...chunk);
  return out;
}

const MAGIC = [...new TextEncoder().encode("!<arch>\n")];

test("peeks the prefix and replays the whole body", async () => {
  const body = [...MAGIC, 1, 2, 3, 4, 5];
  const { bytes, stream } = await peekBytes(streamOf([body]), 8);

  assert.equal(new TextDecoder().decode(bytes), "!<arch>\n");
  assert.deepEqual(await drain(stream), body, "forwarded bytes must be intact");
});

test("spans chunk boundaries smaller than the prefix", async () => {
  // A body arriving one or two bytes at a time still has to produce all 8
  // magic bytes, and read-ahead must not swallow the chunks that follow.
  const tail = [9, 8, 7];
  const chunks = [...MAGIC.map((b) => [b]), tail];
  const { bytes, stream } = await peekBytes(streamOf(chunks), 8);

  assert.equal(new TextDecoder().decode(bytes), "!<arch>\n");
  assert.deepEqual(await drain(stream), [...MAGIC, ...tail]);
});

test("does not drain the source to see the prefix", async () => {
  // The whole point is not buffering the file: after peeking, nearly all of the
  // body must still be sitting unread in the source stream.
  const CHUNKS = 100;
  let pulled = 0;
  const source = new ReadableStream({
    pull(controller) {
      if (pulled === CHUNKS) return controller.close();
      pulled++;
      controller.enqueue(Uint8Array.from([pulled, pulled, pulled]));
    },
  });

  const { stream } = await peekBytes(source, 8);
  // 3 chunks of 3 bytes cover the 8; one more can be pulled because a default
  // stream keeps a chunk of read-ahead queued.
  assert.ok(pulled <= 4, `peeked 8 bytes after ${pulled} chunks, expected ≤ 4`);

  const expected = [];
  for (let i = 1; i <= CHUNKS; i++) expected.push(i, i, i);
  assert.deepEqual(await drain(stream), expected);
});

test("a body shorter than the prefix cannot pass as a deb", async () => {
  const { bytes, stream } = await peekBytes(streamOf([[0x21, 0x3c]]), 8);

  assert.equal(bytes.length, 2);
  assert.notEqual(new TextDecoder().decode(bytes), "!<arch>\n");
  assert.deepEqual(await drain(stream), [0x21, 0x3c]);
});

test("an empty body yields nothing to forward", async () => {
  const { bytes, stream } = await peekBytes(streamOf([]), 8);

  assert.equal(bytes.length, 0);
  assert.deepEqual(await drain(stream), []);
});
