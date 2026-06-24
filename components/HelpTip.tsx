// Small "?" badge that explains a control on hover (native tooltip — works
// everywhere, including inside tables, with no clipping/positioning issues).
export default function HelpTip({ text }: { text: string }) {
  return (
    <span className="help-tip" title={text} role="img" aria-label={`Help: ${text}`}>
      ?
    </span>
  );
}
