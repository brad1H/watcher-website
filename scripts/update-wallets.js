const puppeteer = require('puppeteer');
const fs = require('fs');

async function scrapeLeaderboard() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

  console.log('Navigating to KOL Scan leaderboard...');
  await page.goto('https://kolscan.io/leaderboard', { waitUntil: 'networkidle2', timeout: 45000 });

  // Try clicking Monthly tab
  try {
    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('button, a, span, div'));
      const monthly = els.find(el => el.textContent.trim().toLowerCase() === 'monthly');
      if (monthly) monthly.click();
    });
    await new Promise(r => setTimeout(r, 3000));
    console.log('Clicked Monthly tab');
  } catch(e) {
    console.log('Could not click Monthly tab, using default view');
  }

  // Wait for wallet rows to appear
  await page.waitForSelector('a[href*="/account/"]', { timeout: 20000 });
  await new Promise(r => setTimeout(r, 2000));

  // Debug: dump first link structure so we can diagnose selector issues
  const debug = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="/account/"]');
    const first = links[0];
    return {
      totalLinks: links.length,
      firstHref: first ? first.getAttribute('href') : 'none',
      firstHTML: first ? first.innerHTML.slice(0, 800) : 'none'
    };
  });
  console.log('DEBUG:', JSON.stringify(debug, null, 2));

  const wallets = await page.evaluate(() => {
    function parsePnl(text) {
      // Handle K/M suffixes and various formats: +$49.2K, -$1.2M, $49,178, ($49,178)
      const negative = text.includes('-') || (text.includes('(') && text.includes(')'));
      const cleaned = text.replace(/[^0-9.KMkm]/g, '');
      if (!cleaned) return null;
      let num;
      if (/[Kk]$/.test(cleaned)) {
        num = parseFloat(cleaned) * 1000;
      } else if (/[Mm]$/.test(cleaned)) {
        num = parseFloat(cleaned) * 1000000;
      } else {
        num = parseFloat(cleaned);
      }
      if (isNaN(num)) return null;
      return Math.round(negative ? -num : num);
    }

    const results = [];
    const seen = new Set();
    const links = document.querySelectorAll('a[href*="/account/"]');

    links.forEach(link => {
      const href = link.getAttribute('href') || '';
      const match = href.match(/\/account\/([A-Za-z0-9]{32,})/);
      if (!match) return;

      const address = match[1];
      if (seen.has(address)) return;
      seen.add(address);

      // Try heading tags first, then fall back to first non-empty meaningful text node
      let name = null;
      const heading = link.querySelector('h1, h2, h3, h4, h5, h6');
      if (heading && heading.textContent.trim()) {
        name = heading.textContent.trim();
      } else {
        // Walk all child elements, pick first one that looks like a name (not a number/symbol)
        const els = Array.from(link.querySelectorAll('*'));
        for (const el of els) {
          const t = el.childNodes.length === 1 && el.firstChild.nodeType === 3
            ? el.textContent.trim() : '';
          if (t && t.length > 1 && !/^[\d$+\-%.(),KMk]+$/.test(t)) {
            name = t;
            break;
          }
        }
      }
      if (!name) return;

      const spans = Array.from(link.querySelectorAll('span')).map(s => s.textContent.trim()).filter(Boolean);

      let pnl = null;
      let wr = null;

      for (let i = 0; i < spans.length; i++) {
        const s = spans[i];

        // PnL: any span containing $ sign
        if (s.includes('$') && pnl === null) {
          const val = parsePnl(s);
          if (val !== null) pnl = val;
        }

        // Win rate: direct percentage like "52%"
        if (/^\d+(\.\d+)?%$/.test(s) && wr === null) {
          wr = Math.round(parseFloat(s));
        }

        // Win rate: wins / losses format
        if (s === '/' && wr === null) {
          const w = parseInt(spans[i - 1]);
          const l = parseInt(spans[i + 1]);
          if (!isNaN(w) && !isNaN(l) && (w + l) > 0) {
            wr = Math.round((w / (w + l)) * 100);
          }
        }
      }

      results.push({ address, name, pnl, wr });
    });

    return results.slice(0, 50);
  });

  await browser.close();
  console.log(`Scraped ${wallets.length} wallets`);
  wallets.forEach((w, i) => console.log(`  ${i+1}. ${w.name} | pnl:${w.pnl} wr:${w.wr}`));
  return wallets;
}

async function updateHtml(scraped) {
  if (scraped.length === 0) {
    console.log('No wallets scraped — aborting to avoid wiping data.');
    process.exit(1);
  }

  const content = fs.readFileSync('websitewalletnova.html', 'utf8');

  // Preserve existing emojis by address
  const emojiMap = {};
  const existingRegex = /\{\s*rank:\d+,\s*name:"[^"]*",\s*emoji:"([^"]*)",\s*address:"([^"]*)"/g;
  let em;
  while ((em = existingRegex.exec(content)) !== null) {
    emojiMap[em[2]] = em[1];
  }

  const defaultEmojis = ['⭐','🌟','💫','✨','🎯','🔥','💎','🚀','⚡','🌊','🎪','🏅','🎲','🃏','🧠','👁️','🌀','🎨','🎭','🎬'];
  let emojiIdx = 0;

  const lines = scraped.map((w, i) => {
    const emoji = emojiMap[w.address] || defaultEmojis[emojiIdx++ % defaultEmojis.length];
    const pnl = w.pnl !== null ? w.pnl : 'null';
    const wr  = w.wr  !== null ? w.wr  : 'null';
    return `  { rank:${String(i+1).padEnd(2)}, name:"${w.name}", emoji:"${emoji}", address:"${w.address}", pnl:${pnl}, wr:${wr} }`;
  });

  const newArray = `const wallets = [\n${lines.join(',\n')},\n];`;

  const start = content.indexOf('const wallets = [');
  const end   = content.indexOf('\nconst insiderWallets');
  if (start === -1 || end === -1) {
    console.error('Could not find wallets array in websitewalletnova.html');
    process.exit(1);
  }

  const updated = content.slice(0, start) + newArray + content.slice(end);
  fs.writeFileSync('websitewalletnova.html', updated, 'utf8');
  console.log('websitewalletnova.html updated successfully.');
}

(async () => {
  try {
    const scraped = await scrapeLeaderboard();
    await updateHtml(scraped);
  } catch (err) {
    console.error('Update failed:', err.message);
    process.exit(1);
  }
})();
