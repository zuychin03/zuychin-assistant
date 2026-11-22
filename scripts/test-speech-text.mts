import assert from "node:assert/strict";
import { stripMarkdown } from "../src/lib/speech.ts";

let passed = 0;
function check(name: string, run: () => void) {
    run();
    passed++;
    console.log(`PASS ${name}`);
}

check("a list reply keeps one line per item, without markers", () => {
    const reply = "Here's your day:\n- Dentist at 9:30\n2. Capstone meeting at 2\n• Gym after work\n10) Read\n\n## Next\nAnything else?";
    assert.equal(stripMarkdown(reply), "Here's your day:\nDentist at 9:30\nCapstone meeting at 2\nGym after work\nRead\nNext\nAnything else?");
});

check("spaces inside a line collapse and lines with nothing to say are dropped", () => {
    assert.equal(stripMarkdown("  Two   spaces\there \r\n---\n| --- |\n\n\nEnd."), "Two spaces here\nEnd.");
});

check("links, images, inline code and fences become plain words", () => {
    assert.equal(stripMarkdown("See [the docs](https://example.invalid) ![chart](x.png) and `npm test`."), "See the docs and npm test.");
    assert.equal(stripMarkdown("Run this:\n```sh\nnpm test\n```\nDone."), "Run this:\n(code omitted)\nDone.");
});

check("a year or a sentence that starts with a number is not taken for a list marker", () => {
    assert.equal(stripMarkdown("2026. Was a busy year.\n3 apples left."), "2026. Was a busy year.\n3 apples left.");
});

check("emphasis and quote marks are removed without joining lines", () => {
    assert.equal(stripMarkdown("> **Bold** start\n_and_ end"), "Bold start\nand end");
});

console.log(`Speech text: ${passed} checks passed.`);
