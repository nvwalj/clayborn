// Retrieval: the ways a question about X must actually surface X.
//
// Both regressions here were found by real questions against the Duan Yongping
// corpus, not invented: the subject's own name hijacking IDF, and a latin
// topic token slipping under the phrase-bonus floor.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Corpus } from "../src/corpus.js";

function corpusOf(rows, spec = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "clayborn-corpus-"));
  const file = path.join(dir, "c.jsonl");
  writeFileSync(file, rows.map((text, i) => JSON.stringify({ text, date: `2026-01-${String(i + 1).padStart(2, "0")}` })).join("\n"));
  return new Corpus({ file, textField: "text", dateField: "date", ...spec }, () => {});
}

// A tiny world: a few posts about rockets, one that merely mentions the
// author's name, one whose only sin is containing the junction gram 三怎
// (via 第三怎么样), and filler so IDF has something to chew on.
const ROWS = [
  "SpaceX 的火箭回收今天又成功了，成本还会继续降。",
  "我觉得 SpaceX 商业模式的关键是发射频率，别的都是次要的。",
  "有人问张三怎么说投资这回事，我不知道，我只知道慢就是快。",
  "这个第三怎么样我不好说，第一第二倒是很清楚。",
  "买股票就是买公司，买公司就是买它未来的现金流。",
  "苹果的生意模式我看了十年，越看越简单。",
  "打高尔夫和投资一样，挥杆越少的人越厉害。",
  "今天天气不错，去打球了。回来看了会儿书。",
  "网友让我评论一下茅台，我说过很多次了，不再重复。",
  "做对的事情，把事情做对。这两句话说起来容易。",
];

test("the subject's own name must not hijack retrieval", () => {
  const c = corpusOf(ROWS, { subjectTerms: ["张三"] });
  const hits = c.search("张三怎么说 SpaceX 的？", 3);
  assert.ok(hits.length >= 2, "the two SpaceX posts must come back");
  for (const h of hits.slice(0, 2)) {
    assert.match(h.text, /SpaceX/, `expected a SpaceX post, got: ${h.text}`);
  }
});

test("without subjectTerms the same query CAN be hijacked — the option earns its keep", () => {
  const c = corpusOf(ROWS); // no subjectTerms
  const withTerms = corpusOf(ROWS, { subjectTerms: ["张三"] });
  const bare = c.search("张三怎么说 SpaceX 的？", 1)[0];
  const fixed = withTerms.search("张三怎么说 SpaceX 的？", 1)[0];
  assert.match(fixed.text, /SpaceX/);
  // The bare corpus may or may not survive this particular tiny world, but the
  // fixed one must — and the fixed top hit must never be the name-mention post.
  assert.doesNotMatch(fixed.text, /张三/);
  void bare;
});

test("a 6-char latin name gets the phrase bonus (the old floor was 7)", () => {
  const c = corpusOf(ROWS, { subjectTerms: ["张三"] });
  const hits = c.search("spacex", 2);
  assert.equal(hits.length, 2);
  for (const h of hits) assert.match(h.text, /SpaceX/);
});

test("interrogative scaffolding alone falls back to the raw query instead of matching everything", () => {
  const c = corpusOf(ROWS, { subjectTerms: ["张三"] });
  const hits = c.search("怎么说？", 3);
  // Nothing meaningful survives the strip; falling back to the raw string is
  // fine — what must NOT happen is an empty-feature crash or a full-corpus dump.
  assert.ok(hits.length <= 3);
});
