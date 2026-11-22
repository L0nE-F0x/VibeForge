import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, Field, Input, Select, TextArea, splitHint } from "../../src/ui/components/ui.js";
import { VibySprite } from "../../src/ui/components/Pixel.js";

describe("UI primitives", () => {
  it("associates Field label htmlFor with child Input, Select, and TextArea controls", () => {
    const htmlInput = renderToStaticMarkup(
      <Field label="API endpoint">
        <Input defaultValue="http://localhost" />
      </Field>,
    );
    const idMatch = /<label[^>]*for="([^"]+)"/.exec(htmlInput);
    expect(idMatch).not.toBeNull();
    expect(htmlInput).toMatch(new RegExp(`<input[^>]* id="${idMatch?.[1]}"`));

    const htmlExplicit = renderToStaticMarkup(
      <Field label="Branch">
        <Select id="custom-branch">
          <option value="main">main</option>
        </Select>
      </Field>,
    );
    expect(htmlExplicit).toContain('<label class="field-label" for="custom-branch">Branch</label>');
    expect(htmlExplicit).toMatch(/<select[^>]* id="custom-branch"/);

    const htmlTextArea = renderToStaticMarkup(
      <Field label="Brief">
        <TextArea defaultValue="Write tests" />
      </Field>,
    );
    const taMatch = /<label[^>]*for="([^"]+)"/.exec(htmlTextArea);
    expect(taMatch).not.toBeNull();
    expect(htmlTextArea).toMatch(new RegExp(`<textarea[^>]* id="${taMatch?.[1]}"`));

    const htmlComposite = renderToStaticMarkup(
      <Field label="Group">
        <div>custom content</div>
      </Field>,
    );
    expect(htmlComposite).toContain('<span class="field-label">Group</span>');
  });

  it("splits long hints past the threshold across Western and CJK punctuation", () => {
    expect(splitHint("Short hint.")).toBeNull();

    const western = "This sets the default folder for newly created repositories in VibeForge. Additional helper text explains fallback behavior in full detail.";
    const w = splitHint(western);
    expect(w).toEqual({
      first: "This sets the default folder for newly created repositories in VibeForge.",
      rest: "Additional helper text explains fallback behavior in full detail.",
    });

    const cjk = "この設定は新しいワークスペースを作成する既定の場所を指定します。詳細なフォールバック挙動については追加の説明を参照してください。追加の長文テキストをここに続けます。";
    const c = splitHint(cjk, 60);
    expect(c).toEqual({
      first: "この設定は新しいワークスペースを作成する既定の場所を指定します。",
      rest: "詳細なフォールバック挙動については追加の説明を参照してください。追加の長文テキストをここに続けます。",
    });

    const fieldHtml = renderToStaticMarkup(
      <Field label="Path" hint={western}>
        <Input />
      </Field>,
    );
    expect(fieldHtml).toContain("This sets the default folder for newly created repositories in VibeForge.");
    expect(fieldHtml).toContain('class="hint-more"');
    expect(fieldHtml).toContain('aria-label="Additional helper text explains fallback behavior in full detail."');
  });

  it("renders Button accessibility attributes for icon-only, busy, and pressed states", () => {
    const iconOnly = renderToStaticMarkup(<Button tip="Close drawer" />);
    expect(iconOnly).toContain('aria-label="Close drawer"');
    expect(iconOnly).toContain('class="btn icon"');

    const busyBtn = renderToStaticMarkup(
      <Button variant="primary" busy pressed>
        Save
      </Button>,
    );
    expect(busyBtn).toContain("disabled");
    expect(busyBtn).toContain('aria-pressed="true"');
    expect(busyBtn).toContain('class="btn primary"');
  });

  it("renders VibySprite SVG cleanly in SSR with label or aria-hidden fallback", () => {
    const labeled = renderToStaticMarkup(<VibySprite mood="speaking" size={32} animated={false} label="Viby assistant" />);
    expect(labeled).toContain("<svg");
    expect(labeled).toContain('role="img"');
    expect(labeled).toContain('aria-label="Viby assistant"');
    expect(labeled).toContain('class="viby-sprite mood-speaking"');

    const decorative = renderToStaticMarkup(<VibySprite mood="idle" animated={false} />);
    expect(decorative).toContain('aria-hidden="true"');
    expect(decorative).not.toContain('role="img"');
  });
});
