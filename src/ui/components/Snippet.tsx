import { snippetParts } from "../../shared/text.js";

/** The words around a search match, with the matched words marked. */
export function Snippet({ text, className }: { text: string; className?: string }) {
  if (!text) return null;
  return (
    <span className={`snippet ${className ?? ""}`}>
      {snippetParts(text).map((part, index) => (part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>))}
    </span>
  );
}
