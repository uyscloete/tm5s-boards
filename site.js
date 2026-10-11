// Shared by the website pages: kept board pages and reused signed links (TM5S stand_sync).
// A published page never changes (its name carries its revision and fingerprint), so the browser
// keeps it; a later visit opens without downloading it again.
async function tm5sStandPage(sb, path) {
  const key = new Request(new URL('stand-page/' + path, location.href));
  const cache = typeof caches === 'undefined' ? null : await caches.open('tm5s-stand-pages').catch(() => null);
  const kept = cache && await cache.match(key);
  if (kept) return kept.blob();
  const {data, error} = await sb.storage.from('stands').download(path);
  if (error) throw error;
  if (cache) await cache.put(key, new Response(data)).catch(() => {});
  return data;
}

// The same signed link for a photo while it is valid lets the browser reuse the photo it holds.
async function tm5sSignedLinks(sb, names) {
  const links = {}, wanted = [], now = Date.now();
  for (const name of names) {
    try {
      const kept = JSON.parse(localStorage.getItem('tm5s-signed:' + name) || 'null');
      if (kept && kept.until - now > 2 * 3600 * 1000) { links[name] = kept.url; continue; }
    } catch (error) { /* No browser storage: sign again. */ }
    wanted.push(name);
  }
  if (wanted.length) {
    const {data, error} = await sb.storage.from('stands').createSignedUrls(wanted.map(name => 'assets/' + name), 12 * 3600);
    if (error) throw error;
    data.forEach((row, i) => {
      links[wanted[i]] = row.signedUrl;
      try { localStorage.setItem('tm5s-signed:' + wanted[i], JSON.stringify({url: row.signedUrl, until: now + 12 * 3600 * 1000})); } catch (error) { /* kept for this visit only */ }
    });
  }
  return links;
}
