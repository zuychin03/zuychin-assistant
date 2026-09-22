import assert from "node:assert/strict";
import test from "node:test";
import { filterModelGroups, modelSearchTerms, nextModelOption, type ModelPickerGroup } from "../src/app/home/model-picker.ts";
import { PROVIDERS } from "../src/lib/ai/providers.ts";
import { getModelMeta } from "../src/lib/ai/model-meta.ts";

const groups: ModelPickerGroup[] = PROVIDERS.filter((provider) => !provider.unavailableReason).map((provider) => ({
    label: provider.label,
    options: provider.chatModels.map((model) => ({
        value: `${provider.id}::${model.id}`,
        label: model.label,
        searchTerms: modelSearchTerms({ ...model, meta: getModelMeta(model.id) }),
    })),
}));

test("combined provider, model and capability terms find the correct endpoint", () => {
    const result = filterModelGroups(groups, "NVIDIA DeepSeek vision");
    assert.equal(result.length, 1);
    assert.equal(result[0].options.length, 1);
    assert.equal(result[0].options[0].value, "nvidia-nim::deepseek-ai/deepseek-v4.1-flash");
    assert.deepEqual(filterModelGroups(groups, "NVIDIA DeepSeek web search"), []);
    assert.ok(filterModelGroups(groups, "Gemini structured output").every((group) => group.label.includes("Gemini")));
});

test("unsupported endpoint capabilities are not inferred from family strengths", () => {
    const terms = modelSearchTerms({
        id: "example",
        supportsTools: false,
        supportsVision: false,
        supportsThinking: false,
        supportsSearch: false,
        meta: { developer: "Example", strengths: ["Vision", "Multimodal", "Tool use", "Reasoning", "Coding"] },
    });
    const fixture = [{ label: "Example", options: [{ value: "example", label: "Compact model", searchTerms: terms }] }];
    for (const query of ["vision", "multimodal", "tools", "reasoning", "web search"]) {
        assert.deepEqual(filterModelGroups(fixture, query), [], query);
    }
    assert.equal(filterModelGroups(fixture, "coding")[0].options.length, 1);
});

test("search ignores case, accents and separator differences without changing option values", () => {
    const fixture = [{ label: "Nhà cung cấp", options: [{ value: "stable::model-id", label: "Mô hình Việt", searchTerms: ["function calling"] }] }];
    const result = filterModelGroups(fixture, "  NHA viET function-calling  ");
    assert.equal(result[0].options[0].value, "stable::model-id");
    assert.equal(result[0].options[0], fixture[0].options[0]);
});

test("empty search preserves ordering and no-match queries remove empty groups", () => {
    const original = structuredClone(groups);
    assert.equal(filterModelGroups(groups, "   "), groups);
    assert.deepEqual(filterModelGroups(groups, "no-such-model-98765"), []);
    filterModelGroups(groups, "flash");
    assert.deepEqual(groups, original);
});

test("embedding capabilities are searchable independently of chat capabilities", () => {
    const terms = modelSearchTerms({ id: "embed", dimension: 2048, supportsTools: false });
    const fixture = [{ label: "Provider", options: [{ value: "embed", label: "Embed", searchTerms: terms }] }];
    assert.equal(filterModelGroups(fixture, "retrieval 2048")[0].options.length, 1);
    assert.deepEqual(filterModelGroups(fixture, "tools"), []);
});

test("keyboard navigation clamps at boundaries and handles a filtered empty list", () => {
    assert.equal(nextModelOption(0, 3, "ArrowUp"), 0);
    assert.equal(nextModelOption(2, 3, "ArrowDown"), 2);
    assert.equal(nextModelOption(0, 3, "End"), 2);
    assert.equal(nextModelOption(2, 3, "Home"), 0);
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) assert.equal(nextModelOption(0, 0, key), -1);
});
