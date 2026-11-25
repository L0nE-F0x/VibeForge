import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoadFailed } from "../../src/ui/components/LoadState.js";

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
