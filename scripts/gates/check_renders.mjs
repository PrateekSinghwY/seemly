// RENDERS gate.
//
// Type-clean and lint-clean is not the same as renders. Two faults got through every
// other gate in this build and only a real page load caught them:
//   * every component existed but nothing mounted them (page.tsx returned null)
//   * Tailwind emitted nothing at all, so every utility class was inert — the nav was
//     13608px tall instead of 44px
//
// It never assumes :3000 is free. `pnpm dev` failing with EADDRINUSE while an older
// server answered on that port is why the Tailwind fault stayed invisible: the checks
// were passing against a stale process.
import { spawn } from "child_process";
import { createServer } from "net";
import { chromium } from "playwright";

const ROOT = process.cwd();

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.once("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});

const waitFor = async (url, ms = 90000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
};

const api = await freePort();
const web = await freePort();
const procs = [];
const kill = () => procs.forEach(p => { try { process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ } });
process.on("exit", kill);

let failed = null;
let browser = null;
try {
  procs.push(spawn("uv", ["run", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(api), "--log-level", "warning"],
    { cwd: `${ROOT}/backend`, detached: true, stdio: "ignore" }));
  if (!await waitFor(`http://127.0.0.1:${api}/api/health`)) throw new Error(`backend did not start on ${api}`);

  // `pnpm dev` hardcodes -p 3000, so a trailing -p is ignored; invoke next directly.
  procs.push(spawn("pnpm", ["exec", "next", "dev", "-p", String(web)], {
    cwd: `${ROOT}/frontend`, detached: true, stdio: "ignore",
    env: { ...process.env, NEXT_PUBLIC_API_BASE_URL: `http://127.0.0.1:${api}/api` },
  }));
  if (!await waitFor(`http://127.0.0.1:${web}/`)) throw new Error(`frontend did not start on ${web}`);

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${web}/`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(2500);

  // Every route, not just `/`: a dynamic segment can render empty with a 200 while the
  // static route is fine (LESSONS #21).
  const routes = ['/', '/nfl', '/college-football', '/nba', '/wnba'];
  const perRoute = [];
  for (const rt of routes) {
    await page.goto(`http://127.0.0.1:${web}${rt}`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(1500);
    const got = await page.evaluate(() => ({
      modules: document.querySelectorAll('main [data-module]').length,
      cards: document.querySelectorAll('[data-feed-kind]').length,
      height: document.body.scrollHeight,
    }));
    perRoute.push({ route: rt, ...got });
  }

  await page.goto(`http://127.0.0.1:${web}/`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1200);
  const r = await page.evaluate(() => {
    const nav = document.querySelector("nav");
    return {
      tailwindLoaded: [...document.styleSheets].some(s => {
        try { return [...s.cssRules].some(c => c.cssText && c.cssText.includes("--tw-")); }
        catch { return false; }
      }),
      navHeight: nav ? Math.round(nav.getBoundingClientRect().height) : null,
      hashAnchors: document.querySelectorAll('a[href="#"]').length,
      landmarks: { header: !!document.querySelector("header"), main: !!document.querySelector("main") },
      navPillars: document.querySelectorAll("nav li").length,
    };
  });

  const problems = [];
  if (!r.tailwindLoaded) problems.push("Tailwind emitted nothing — every utility class is inert");
  if (r.navHeight !== 44) problems.push(`nav height is ${r.navHeight}, captured height is 44`);
  if (r.hashAnchors > 0) problems.push(`${r.hashAnchors} anchor(s) to "#" — a live-looking control going nowhere`);
  if (!r.landmarks.header || !r.landmarks.main) problems.push("missing header or main landmark");
  if (r.navPillars === 0) problems.push("navigation rendered no pillars — the shell is not fetching");
  for (const pr of perRoute) {
    if (pr.modules === 0 || pr.height < 400) {
      problems.push(`${pr.route} rendered empty (modules ${pr.modules}, height ${pr.height}) — likely a stale .next cache, see LESSONS #21`);
    }
  }

  console.log(`check_renders: loaded / on :${web} (api :${api}) at 1440x900`);
  console.log(`    tailwind ${r.tailwindLoaded} · nav ${r.navHeight}px · pillars ${r.navPillars} · href="#" ${r.hashAnchors}`);
  perRoute.forEach(pr => console.log(`    ${pr.route.padEnd(20)} modules ${String(pr.modules).padStart(2)}  cards ${String(pr.cards).padStart(2)}  h ${pr.height}`));
  if (problems.length) { failed = problems; }
} catch (e) {
  failed = [String(e.message || e)];
} finally {
  if (browser) { try { await browser.close(); } catch { /* already gone */ } }
}

kill();
if (failed) { console.log("\nFAIL:"); failed.forEach(p => console.log(`    ${p}`)); process.exit(1); }
console.log("PASS: the app renders the shell correctly");
