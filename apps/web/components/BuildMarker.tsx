export function BuildMarker() {
  const sha = process.env.NEXT_PUBLIC_BUILD_SHA?.trim() || "unknown";
  return <p className="meta">Build: <code>{sha}</code></p>;
}
