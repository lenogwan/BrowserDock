/** Validate browser-exported links without inserting their HTML into the app.
 * @param {{title: string, url: string, folder: string|null}[]} links
 */
export function normalizeImport(links) {
  if (links.length > 1000) throw Error('Import up to 1000 bookmarks at a time.');
  const items = [], rejected = [];
  const encoder = new TextEncoder();
  for (const link of links) {
    try {
      const url = new URL(link.url);
      const title = link.title.trim() || url.hostname;
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[\x00-\x20\x7f]/.test(link.url) || encoder.encode(link.url).length > 2048 || encoder.encode(title).length > 512) throw Error('Unsafe or oversized bookmark');
      if (link.folder && [...link.folder].length > 64) throw Error('Folder name exceeds 64 characters');
      items.push({ title, url: link.url, folder: link.folder?.trim() || null });
    } catch { rejected.push(link.title || 'Untitled bookmark'); }
  }
  return { items, rejected };
}
/** @param {string} html */
export function parseBookmarkHtml(html) {
  if (new TextEncoder().encode(html).length > 4 * 1024 * 1024) throw Error('Bookmark HTML must be at most 4 MB.');
  // template contents are inert: parsing never loads images, frames or scripts.
  const template = document.createElement('template');
  template.innerHTML = html;
  const anchors = template.content.querySelectorAll('a[href]');
  if (anchors.length > 1000) throw Error('Import up to 1000 bookmarks at a time.');
  const links = [...anchors].map(a => {
    let folder = null;
    for (let node = a.parentElement; node; node = node.parentElement) {
      if (node.tagName !== 'DL') continue;
      const previous = node.previousElementSibling;
      const heading = previous?.tagName === 'H3' ? previous : node.parentElement?.tagName === 'DT' ? node.parentElement.querySelector(':scope > h3') : null;
      if (heading) { folder = heading.textContent?.trim() || null; break; }
    }
    return { title: a.textContent || '', url: a.getAttribute('href') || '', folder };
  });
  if (!links.length) throw Error('No bookmarks found. Choose a browser-exported bookmark HTML file.');
  return normalizeImport(links);
}
