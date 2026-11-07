import { describe, expect, it } from "vitest";
import type { ApprovedComponent } from "@open-inspect/shared/types/approved-components";
import type { ComponentCategory } from "@open-inspect/shared/types/stack-policy";
import {
  buildStackLanes,
  formatSignalLines,
  parseSignalLines,
  standardPromotion,
} from "./approved-components-model";

const category: ComponentCategory = {
  id: "web-frontend",
  name: "Web frontend",
  description: "Anything rendered in a browser.",
  enforcement: "block",
  revision: 1,
  sourceKind: "app",
  createdBy: "system",
  updatedBy: "system",
  createdAt: 0,
  updatedAt: 0,
};

function component(overrides: Partial<ApprovedComponent>): ApprovedComponent {
  return {
    id: "component",
    name: "Component",
    kind: "library",
    description: "A component",
    owner: "platform-engineering",
    locator: "https://example.com",
    version: null,
    integrity: null,
    sourceUrl: null,
    documentationUrl: "https://example.com",
    usage: "Use it.",
    lifecycle: "approved",
    repoScopes: null,
    environmentScopes: null,
    enabled: true,
    categoryId: "web-frontend",
    stance: "allowed",
    signals: [{ kind: "package", ecosystem: "npm", name: "component" }],
    revision: 3,
    sourceKind: "app",
    createdBy: "system",
    updatedBy: "system",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const svelte = component({ id: "svelte", name: "Svelte", stance: "preferred" });
const vue = component({ id: "vue", name: "Vue" });
const react = component({ id: "react", name: "React", stance: "denied" });
const draftSolid = component({
  id: "solid",
  name: "Solid",
  stance: "preferred",
  lifecycle: "development",
});

describe("buildStackLanes", () => {
  it("groups a category's components by grade and finds the standard in effect", () => {
    const [lane] = buildStackLanes(
      [category],
      [svelte, vue, react, draftSolid, component({ id: "auth", categoryId: null })]
    );

    expect(lane?.components.preferred.map(({ name }) => name)).toEqual(["Svelte", "Solid"]);
    expect(lane?.components.allowed.map(({ name }) => name)).toEqual(["Vue"]);
    expect(lane?.components.denied.map(({ name }) => name)).toEqual(["React"]);
    expect(lane?.standard?.name).toBe("Svelte");
  });

  it("has no standard when the only preferred component is a draft", () => {
    const [lane] = buildStackLanes([category], [draftSolid]);
    expect(lane?.standard).toBeNull();
  });
});

describe("signal lines", () => {
  it("round-trips every signal kind through its canonical key", () => {
    const text = "package:npm:@acme/*\nfile:bun.lock\nsource:.ts\nmanifest:d1";
    const parsed = parseSignalLines(`${text}\n\n`);

    expect(parsed).toEqual({
      ok: true,
      signals: [
        { kind: "package", ecosystem: "npm", name: "@acme/*" },
        { kind: "file", pattern: "bun.lock" },
        { kind: "source", extension: ".ts" },
        { kind: "manifest", value: "d1" },
      ],
    });
    expect(formatSignalLines(parsed.ok ? (parsed.signals as never) : [])).toBe(text);
  });

  it.each([
    ["react", "Line 1: start with package:, file:, source: or manifest:"],
    ["package:react", "Line 1: write package:npm|pypi:<name>"],
    ["file:bun.lock\npackage:cargo:serde", "Line 2: write package:npm|pypi:<name>"],
  ])("rejects %j", (text, message) => {
    expect(parseSignalLines(text)).toEqual({ ok: false, message });
  });
});

describe("standardPromotion", () => {
  it("demotes the current standard in the same request", () => {
    const [lane] = buildStackLanes([category], [svelte, vue]);

    expect(standardPromotion(vue, lane!)).toMatchObject({
      name: "Vue",
      stance: "preferred",
      revision: 3,
      demoteCurrentPreferred: true,
      signals: vue.signals,
    });
  });

  it("demotes nothing when the category has no standard in effect", () => {
    const [lane] = buildStackLanes([category], [vue, draftSolid]);
    expect(standardPromotion(vue, lane!).demoteCurrentPreferred).toBe(false);
  });
});
