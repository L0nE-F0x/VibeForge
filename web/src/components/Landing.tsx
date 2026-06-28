import { useEffect, useState } from "react";
import { PROVIDERS } from "@vibeforge/shared";
import { Icon } from "./Icon.tsx";
import { fetchRadar, RADAR_FALLBACK, type RadarItem } from "../lib/radar.ts";

const STEPS = [
  {
    icon: "key", title: "Bring your model",
    body: "Pick any provider and paste your key — Claude (incl. Opus 4.8), GPT, Gemini, Grok, OpenRouter, or a local model via Ollama / LM Studio. Your key never leaves your browser.",
  },
  {
    icon: "sparkles", title: "Generate grounded ideas",
    body: "Mint batches of original, genuinely useful app concepts — grounded in live web search so they reflect what people actually want. Dial the ambition from a focused tool to a serious product.",
  },
  {
    icon: "file-text", title: "Draft the spec",
    body: "Turn any idea into a complete build spec — stack, architecture, data model, features, acceptance criteria — then refine it conversationally until it's exactly right.",
  },
  {
    icon: "terminal", title: "Hand it to your AI coder",
    body: "Copy the spec, copy a ready-to-paste kickoff prompt, or download a .md — then let Claude Code, Cursor, or Codex build the whole thing.",
  },
];

const FEATURES = [
  { icon: "layers", title: "Bring your own key", body: "Every major provider plus local & open-weight models. No lock-in, no markup — you pay your provider directly." },
  { icon: "lock", title: "Private by design", body: "Keys and ideas live only in your browser. Nothing is stored or logged on a server." },
  { icon: "globe", title: "Grounded in reality", body: "Live web search keeps ideas current and specs accurate to today's tools and libraries." },
  { icon: "refresh", title: "Refine, don't restart", body: "Iterate on a spec conversationally, with one-step undo. Nudge the stack, scope, or features." },
  { icon: "download", title: "Export anywhere", body: "Copy, kickoff prompt, or Markdown — drops straight into any coding assistant." },
  { icon: "flame", title: "Install as an app", body: "Runs as a fast desktop PWA, online or off. One icon, no clutter." },
];

export function Landing({ onEnter }: { onEnter: () => void }) {
  const providerNames = PROVIDERS.filter((p) => p.id !== "custom").map((p) => p.short);

  // Self-updating model feed: render the fallback immediately, upgrade to the
  // live OpenRouter catalogue once it loads (cached, so it's instant on revisit).
  const [radar, setRadar] = useState<RadarItem[]>(RADAR_FALLBACK);
  useEffect(() => {
    const ac = new AbortController();
    fetchRadar(ac.signal).then(setRadar).catch(() => { /* keep fallback */ });
    return () => ac.abort();
  }, []);

  return (
    <div className="landing">
      <header className="lp-nav">
        <div className="brand">
          <div className="anvil"><Icon name="flame" size={17} /></div>
          <div><span className="bt">Vibe Forge</span><span className="sub">App Idea &amp; Spec Studio</span></div>
        </div>
        <button className="btn primary" onClick={onEnter}>Open the studio <Icon name="arrow-right" size={15} /></button>
      </header>

      <section className="lp-hero">
        <div className="lp-glow" />
        <span className="lp-eyebrow"><Icon name="sparkles" size={12} /> Bring your own model · ideas → specs</span>
        <h1>From a spark of an idea<br />to a build-ready spec.</h1>
        <p className="lp-sub">
          Vibe Forge invents genuinely useful app ideas with your favourite AI model, then writes the
          complete build spec — ready to hand to Claude Code, Cursor, or any coding assistant.
        </p>
        <div className="lp-cta">
          <button className="btn primary lg" onClick={onEnter}><Icon name="sparkles" size={16} /> Start forging</button>
          <a className="btn lg" href="#how">See how it works</a>
        </div>
        <div className="lp-providers">
          <span className="faint">Works with</span>
          {providerNames.map((n) => <span className="lp-prov" key={n}>{n}</span>)}
        </div>
      </section>

      <section className="lp-section" id="how">
        <div className="lp-h2">
          <span className="lp-kicker">How it works</span>
          <h2>Four steps from idea to shipped spec</h2>
        </div>
        <div className="lp-steps">
          {STEPS.map((s, i) => (
            <div className="lp-step" key={s.title}>
              <div className="lp-step-top">
                <div className="lp-step-ic"><Icon name={s.icon} size={18} /></div>
                <div className="lp-step-n">{String(i + 1).padStart(2, "0")}</div>
              </div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-h2">
          <span className="lp-kicker">Why Vibe Forge</span>
          <h2>Built for people who ship with AI</h2>
        </div>
        <div className="lp-features">
          {FEATURES.map((f) => (
            <div className="lp-feat" key={f.title}>
              <div className="lp-feat-ic"><Icon name={f.icon} size={17} /></div>
              <div><h3>{f.title}</h3><p>{f.body}</p></div>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-section" id="radar">
        <div className="lp-h2">
          <span className="lp-kicker">Live model feed</span>
          <h2>Fresh off the forge</h2>
          <p className="lp-h2-sub">
            The newest models to land across every major provider — pulled live from the catalogue, so this list keeps itself current.
          </p>
        </div>
        <div className="lp-radar">
          {radar.map((r) => {
            const fresh = (Date.now() / 1000 - r.created) / 86400 <= 21;
            const date = r.created
              ? new Date(r.created * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
              : "Recently";
            return (
              <div className="lp-radar-item" key={r.id}>
                <div className="lp-radar-badge">
                  <span className={`lp-badge ${fresh ? "new" : "recent"}`}>{fresh ? "New" : "Recent"}</span>
                </div>
                <div className="lp-radar-main">
                  <h3>{r.model} <span className="lp-radar-prov">{r.provider}</span></h3>
                  <p>{r.note}</p>
                  <a href={r.href} target="_blank" rel="noreferrer">View on OpenRouter <Icon name="external-link" size={11} /></a>
                </div>
                <div className="lp-radar-eta"><Icon name="clock" size={12} /> {date}</div>
              </div>
            );
          })}
        </div>
        <p className="lp-radar-foot">Auto-updated · live from the OpenRouter catalogue</p>
      </section>

      <section className="lp-final">
        <div className="lp-glow soft" />
        <h2>Your next app is one idea away.</h2>
        <p>No account, no sign-up — just your own API key and a couple of minutes.</p>
        <button className="btn primary lg" onClick={onEnter}><Icon name="flame" size={16} /> Open the studio</button>
      </section>

      <footer className="lp-foot">
        <div className="brand">
          <div className="anvil sm"><Icon name="flame" size={13} /></div>
          <span className="bt">Vibe Forge</span>
        </div>
        <span className="faint">Your keys stay in your browser. Built for builders.</span>
      </footer>
    </div>
  );
}
