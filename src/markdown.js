// src/markdown.js — reusable, dependency-free markdown renderer.
//
// SAFE by construction: HTML is escaped FIRST, then a small markdown subset is
// applied (# headings, -/* list items, **bold**, `inline code`, fenced
// ```code blocks```). No raw HTML from the input survives, so agent/model
// text cannot inject markup into the bubble.
//
// UMD: `module.exports` for Node; `window.ClawdMarkdown` for the browser
// renderer. Reuse this from anywhere (bubble, dashboard, settings, session
// detail) by requiring it (Node) or reading `window.ClawdMarkdown` (renderer).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else if (typeof root === "object" && root !== null) {
    root.ClawdMarkdown = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  /** Escape a string for safe insertion into innerHTML. */
  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /** Inline markdown: escape, then apply `code` and **bold**. */
  function inlineMd(value) {
    let out = escapeHtml(value);
    out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
    out = out.replace(/\*\*([^*]+)\*\*/g, (_m, bold) => `<strong>${bold}</strong>`);
    return out;
  }

  /**
   * Render a markdown string to safe HTML. Returns "" for empty input.
   * @param {string} text - the markdown source.
   * @returns {string} sanitized HTML (escaped input + markdown tags only).
   */
  function renderMarkdown(text) {
    if (typeof text !== "string" || !text.trim()) return "";
    const lines = String(text).split(/\r?\n/);
    let html = "";
    let inFence = false;
    let codeBuf = [];
    let listOpen = false;
    const flushList = () => { if (listOpen) { html += "</ul>"; listOpen = false; } };
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^```/.test(trimmed)) {
        if (inFence) {
          html += `<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`;
          codeBuf = [];
          inFence = false;
        } else {
          flushList();
          inFence = true;
          codeBuf = [];
        }
        continue;
      }
      if (inFence) { codeBuf.push(line); continue; }
      const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushList();
        const level = Math.min(5, heading[1].length + 1);
        html += `<h${level}>${inlineMd(heading[2])}</h${level}>`;
        continue;
      }
      const item = trimmed.match(/^[-*+]\s+(.*)$/);
      if (item) {
        if (!listOpen) { html += "<ul>"; listOpen = true; }
        html += `<li>${inlineMd(item[1])}</li>`;
        continue;
      }
      if (!trimmed) { flushList(); continue; }
      flushList();
      html += `<p>${inlineMd(trimmed)}</p>`;
    }
    if (inFence) html += `<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`;
    flushList();
    return html;
  }

  return { escapeHtml, renderMarkdown };
});
