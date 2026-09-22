import assert from "node:assert/strict";
import { documentHeadings, parseSections, sectionBody } from "../src/app/graph/cosmos/sections.ts";

const markdown = `---
title: Guide
---
# Guide

## **Repeated**
First section.

### [Evidence](https://example.com)
First evidence.

#### Deeper findings
Nested detail.

## Repeated
Second section.

~~~markdown
## Not a section
~~~

\`\`\`\`text
## Also not a section
\`\`\`
### Still inside the fence
\`\`\`\`

## Kiến thức
Unicode heading.

###### Small detail
Deepest heading.

Final section
-------------
Setext body.
`;

const headings = documentHeadings(markdown);
assert.deepEqual(headings.map(({ title }) => title), [
    "Guide", "Repeated", "Evidence", "Deeper findings", "Repeated", "Kiến thức", "Small detail", "Final section",
]);
assert.equal(new Set(headings.map(heading => heading.id)).size, headings.length);
assert.equal(headings[1].id, "repeated");
assert.equal(headings[4].id, "repeated-2");
assert.equal(headings[5].id, "kiến-thức");
assert.equal(headings[1].line, 3);
assert.match(sectionBody(markdown, "repeated-2"), /Second section/);
assert.doesNotMatch(sectionBody(markdown, "repeated-2"), /First section/);
assert.match(sectionBody(markdown, "repeated"), /First evidence/);
assert.doesNotMatch(sectionBody(markdown, "repeated"), /Second section/);
assert.equal(sectionBody(markdown, "missing"), "");

const { planets } = parseSections(markdown, "Guide");
assert.deepEqual(planets.map(planet => planet.id), ["repeated", "repeated-2", "kiến-thức", "final-section"]);
assert.deepEqual(planets[0].moons.map(moon => moon.id), ["evidence", "deeper-findings"]);
assert.deepEqual(planets[2].moons.map(moon => moon.id), ["small-detail"]);
assert.equal(planets.flatMap(planet => [planet, ...planet.moons]).length, headings.length - 1);
assert.deepEqual(parseSections("A document without headings.", "Guide"), { planets: [] });
assert.deepEqual(parseSections("# Guide", "Guide"), { planets: [] });
assert.equal(documentHeadings("# [[wiki/concepts/graph|Knowledge graph]]")[0].title, "Knowledge graph");
assert.equal(documentHeadings("    # Indented code\n\nReal heading\n============")[0].title, "Real heading");
assert.deepEqual(parseSections("# Guide: Revised title\n\n## Overview\n\n## Methods", "Guide").planets.map(planet => planet.title), ["Overview", "Methods"]);
assert.deepEqual(parseSections("# Part one\n\n# Part two", "Guide").planets.map(planet => planet.title), ["Part one", "Part two"]);
console.log("Cosmos sections: 21 assertions passed (identity, fences, formatting, nesting, reader source lines, title variants).");
