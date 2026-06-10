import { useStore } from "../store.ts";

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismiss);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={"toast " + t.kind} onClick={() => dismiss(t.id)}>
          <b>{t.title}</b>
          {t.body}
        </div>
      ))}
    </div>
  );
}
