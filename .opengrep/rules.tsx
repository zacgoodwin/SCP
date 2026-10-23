// Rule tests for the JSX half of scp.xss.raw-html-sink. See rules.ts.
export function Preview({ html }: { html: string }) {
  return (
    <section>
      {/* ruleid: scp.xss.raw-html-sink */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
      {/* ok: scp.xss.raw-html-sink */}
      <div>{html}</div>
    </section>
  );
}
