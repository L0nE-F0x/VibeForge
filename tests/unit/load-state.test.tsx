import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoadFailed, UnreadableNotice } from "../../src/ui/components/LoadState.js";

const reload = () => Promise.resolve();

describe("a list that couldn't be read", () => {
  it("says so where the list would be, with the reason and Try again", () => {
    const html = renderToStaticMarkup(<LoadFailed query={{ error: "agents/a.yaml: bad indentation", data: undefined, reload, key: "agents", what: "load.agents" }} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Couldn&#x27;t read your agents.");
    expect(html).toContain("agents/a.yaml: bad indentation");
    expect(html).toContain("Nothing was deleted.");
    expect(html).toContain("This doesn&#x27;t mean there&#x27;s nothing here");
    expect(html).toContain("Try again");
  });

  it("says what is shown is from before when an earlier read worked", () => {
    const html = renderToStaticMarkup(<LoadFailed query={{ error: "host down", data: [{ id: "a" }], reload, key: "tasks", what: "load.tasks" }} />);
    expect(html).toContain("Couldn&#x27;t read your tasks.");
    expect(html).toContain("from the last read that worked");
    expect(html).not.toContain("Nothing was deleted.");
  });

  it("names the list it is given, or the page, when the query has no name", () => {
    expect(renderToStaticMarkup(<LoadFailed query={{ error: "EACCES", data: undefined, reload, key: null, what: null }} what="load.files" />)).toContain("Couldn&#x27;t read this folder.");
    expect(renderToStaticMarkup(<LoadFailed query={{ error: "EACCES", data: undefined, reload, key: null, what: null }} />)).toContain("Couldn&#x27;t read part of this page.");
  });

  it("shows nothing while the read is fine", () => {
    expect(renderToStaticMarkup(<LoadFailed query={{ error: null, data: [], reload, key: "agents", what: "load.agents" }} />)).toBe("");
  });
});

describe("files a list left out because they couldn't be read", () => {
  it("names each one with why, says nothing was deleted, and has Try again", () => {
    const files = [
      { kind: "agent" as const, id: "atlas", file: "/h/agents/atlas/agent.yaml", error: "Couldn't read ~/agents/atlas/agent.yaml: VibeForge isn't allowed to. Check its permissions." },
      { kind: "agent" as const, id: "bee", file: "/h/agents/bee/agent.yaml", error: "Couldn't read ~/agents/bee/agent.yaml: it isn't valid YAML (bad indentation)." },
    ];
    const html = renderToStaticMarkup(<UnreadableNotice kind="agent" files={files} reload={reload} />);
    expect(html).toContain('role="status"');
    expect(html).toContain("2 agents couldn&#x27;t be read, so they aren&#x27;t listed:");
    expect(html).toContain("~/agents/atlas/agent.yaml: VibeForge isn&#x27;t allowed to.");
    expect(html).toContain("it isn&#x27;t valid YAML (bad indentation)");
    expect(html).toContain("Nothing was deleted.");
    expect(html).toContain("Try again");
    expect(renderToStaticMarkup(<UnreadableNotice kind="task" files={[{ ...files[0], kind: "task" }]} reload={reload} />)).toContain("1 task couldn&#x27;t be read, so it isn&#x27;t listed:");
  });

  it("shows nothing while every file reads", () => {
    expect(renderToStaticMarkup(<UnreadableNotice kind="skill" files={[]} reload={reload} />)).toBe("");
  });
});
