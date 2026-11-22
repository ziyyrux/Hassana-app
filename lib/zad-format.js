(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ZadFormat = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatInline(escapedText) {
    let out = escapedText;
    // Highlight Quranic verses wrapped in ﴿...﴾
    out = out.replace(/﴿([^﴾]+)﴾/g, '<span class="zq">﴿$1﴾</span>');
    // Bold **...**
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Bracketed citations like [سورة البقرة: 255] or [صحيح البخاري: 1]
    out = out.replace(/\[([^\]]+)\]/g, '<span class="zref">[$1]</span>');
    return out;
  }

  function formatZadMarkup(rawText) {
    if (!rawText || typeof rawText !== 'string') return '';
    const escaped = escapeHtml(rawText.trim());
    const lines = escaped.split(/\r?\n/);

    const parts = [];
    let listBuffer = null; // { tag: 'ul'|'ol', items: [] }
    let inSources = false;

    const flushList = () => {
      if (!listBuffer) return;
      parts.push(`<${listBuffer.tag}>${listBuffer.items.map((it) => `<li>${it}</li>`).join('')}</${listBuffer.tag}>`);
      listBuffer = null;
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        flushList();
        continue;
      }

      // Detect sources section heading (المصادر: or المصادر والمراجع: or Sources:)
      if (/^(?:\*\*)?(?:المصادر(?:\s+والمراجع)?|المراجع|Sources|References)\s*:?(?:\*\*)?$/i.test(line)) {
        flushList();
        if (!inSources) {
          inSources = true;
          parts.push('<div class="zsrc"><p class="zsrc-t">المصادر والمراجع</p>');
        }
        continue;
      }

      // Bullet list item (- or * or •)
      const ulMatch = line.match(/^[-*•]\s+(.+)$/);
      if (ulMatch) {
        if (listBuffer && listBuffer.tag !== 'ul') flushList();
        if (!listBuffer) listBuffer = { tag: 'ul', items: [] };
        listBuffer.items.push(formatInline(ulMatch[1]));
        continue;
      }

      // Ordered list item (1. or 1) or ١.)
      const olMatch = line.match(/^(?:\d+|[٠-٩]+)[.)]\s+(.+)$/);
      if (olMatch) {
        if (listBuffer && listBuffer.tag !== 'ol') flushList();
        if (!listBuffer) listBuffer = { tag: 'ol', items: [] };
        listBuffer.items.push(formatInline(olMatch[1]));
        continue;
      }

      flushList();

      // Markdown heading (### or ##)
      const hMatch = line.match(/^#{1,4}\s+(.+)$/);
      if (hMatch) {
        parts.push(`<h4>${formatInline(hMatch[1])}</h4>`);
        continue;
      }

      parts.push(`<p>${formatInline(line)}</p>`);
    }

    flushList();
    if (inSources) {
      parts.push('</div>');
    }

    return parts.join('');
  }

  function getDefaultFabPos(viewportW, viewportH, size = 54, bottomReserve = 96) {
    const w = Number.isFinite(viewportW) && viewportW > 0 ? viewportW : 390;
    const h = Number.isFinite(viewportH) && viewportH > 0 ? viewportH : 844;
    const x = w > 640 ? Math.max(16, Math.round((w - 600) / 2) + 12) : 16;
    const y = Math.max(16, Math.round(h - size - bottomReserve));
    return clampFabPos({ x, y }, w, h, size, bottomReserve);
  }

  function clampFabPos(pos, viewportW, viewportH, size = 54, bottomReserve = 96) {
    const w = Number.isFinite(viewportW) && viewportW > 0 ? viewportW : 390;
    const h = Number.isFinite(viewportH) && viewportH > 0 ? viewportH : 844;
    const margin = 12;
    const minX = margin;
    const minY = margin;
    const maxX = Math.max(minX, Math.round(w - size - margin));
    const maxY = Math.max(minY, Math.round(h - size - bottomReserve));
    if (!pos || !Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.y))) {
      return {
        x: Math.min(maxX, Math.max(minX, w > 640 ? Math.round((w - 600) / 2) + 12 : 16)),
        y: Math.min(maxY, Math.max(minY, maxY)),
      };
    }
    return {
      x: Math.min(maxX, Math.max(minX, Math.round(Number(pos.x)))),
      y: Math.min(maxY, Math.max(minY, Math.round(Number(pos.y)))),
    };
  }

  return { escapeHtml, formatInline, formatZadMarkup, getDefaultFabPos, clampFabPos };
}));
