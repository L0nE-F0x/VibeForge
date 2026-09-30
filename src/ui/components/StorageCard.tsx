import { FolderOpen, Sparkles } from "lucide-react";
import { call, useQuery, useSettings } from "../api.js";
import { useT, type Translator } from "../i18n/index.js";
import { useAction, useToast } from "../state.js";
import { Button, Field, Segmented, Select } from "./ui.js";

const KEEP_DAYS = ["0", "365", "90", "30"] as const;
const CAPS_MB = [0, 500, 1024, 5 * 1024, 10 * 1024];

/** Bytes as kB, MB or GB, in the reader's language. */
export function sizeText(bytes: number, language: string): string {
  const mb = bytes / 1024 / 1024;
  const [value, unit] = mb >= 1024 ? [mb / 1024, "gigabyte"] : mb >= 1 ? [mb, "megabyte"] : [bytes / 1024, "kilobyte"];
  return new Intl.NumberFormat(language, { style: "unit", unit, maximumFractionDigits: value < 10 ? 1 : 0 }).format(value);
}

function keepLabel(days: string, t: Translator): string {
  if (days === "0") return t("storage.keep.forever");
  if (days === "365") return t("storage.keep.year");
  return t("storage.keep.days", { count: days });
}

/** Settings → Storage: where the disk space goes, how long runs are kept, and tidying up now. */
export function StorageCard() {
  const t = useT();
  const { push } = useToast();
  const settings = useSettings().data;
  const summary = useQuery("storage", ["runs", "settings"], () => call("storage.summary"));
  const [save] = useAction(async (keepRuns: { days: number; maxMb: number }) => call("settings.save", { keepRuns }), t("storage.saveFailed"));
  const [tidy, tidying] = useAction(async () => {
    const done = await call("storage.tidy");
    await summary.reload();
    if (!done.freed && !done.removed) push("info", t("storage.tidiedNothing"));
    else push("success", t("storage.tidied", { size: sizeText(done.freed, t.language) }), t("storage.tidiedDetail", { compressed: done.compressed, removed: done.removed }));
  }, t("storage.tidyFailed"));
  if (!settings) return null;
  const keep = settings.keepRuns;
  const data = summary.data;
  const rows: Array<[string, number, string?]> = data
    ? [
        [t("storage.runs"), data.runs, t.count("storage.runCount", data.runCount)],
        [t("storage.voice"), data.voice],
        [t("storage.scratch"), data.scratch],
        [t("storage.logs"), data.logs],
      ]
    : [];

  return (
    <div className="card vstack" style={{ gap: 14 }}>
      <p className="faint" style={{ margin: 0 }}>{t("storage.hint")}</p>
      {data && (
        <div className="storage-bars" role="list">
          {rows.map(([label, bytes, detail]) => (
            <div key={label} className="storage-row" role="listitem">
              <span className="grow">
                {label}
                {detail && <span className="faint"> · {detail}</span>}
              </span>
              <span className="mono">{sizeText(bytes, t.language)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="form-grid">
        <Field label={t("storage.keepFor")} hint={t("storage.keepHint")}>
          <Segmented
            value={KEEP_DAYS.find((days) => Number(days) === keep.days) ?? "0"}
            options={KEEP_DAYS.map((days) => ({ value: days, label: keepLabel(days, t) }))}
            onChange={(days) => void save({ ...keep, days: Number(days) })}
          />
        </Field>
        <Field label={t("storage.cap")} hint={t("storage.capHint")}>
          <Select value={String(keep.maxMb)} onChange={(event) => void save({ ...keep, maxMb: Number(event.target.value) })} style={{ maxWidth: 220 }}>
            {[...new Set([...CAPS_MB, keep.maxMb])].map((mb) => (
              <option key={mb} value={mb}>
                {mb ? sizeText(mb * 1024 * 1024, t.language) : t("storage.cap.none")}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="hstack wrap" style={{ gap: 8 }}>
        <Button icon={Sparkles} busy={tidying} tip={t("storage.tidyTip")} onClick={() => void tidy()}>
          {t("storage.tidy")}
        </Button>
        {data && (
          <Button icon={FolderOpen} onClick={() => void call("app.openPath", data.dataRoot)}>
            {t("common.openFileManager")}
          </Button>
        )}
      </div>
    </div>
  );
}
