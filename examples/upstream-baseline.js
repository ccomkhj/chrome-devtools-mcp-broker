#!/usr/bin/env node
import { createServer } from 'node:http';
import { createUpstreamFactory } from '../src/upstream.js';

// Baseline for docs/VALIDATION.md: one chrome-devtools-mcp worker on its own (no broker sessions),
// with two pages in separate isolatedContexts. It reports whether the contexts' cookies and pages stay apart.
// Each trial starts one call per page; both calls request
// a barrier URL that answers only after both requests arrive, so it shows whether upstream ran them at
// the same time. test/chrome.e2e.js runs the evaluate_script barrier through the broker.
// --page-id-routing restores upstream's default, which the broker turns off for its workers.
// Usage: node examples/upstream-baseline.js /path/to/chrome
const chromePath = process.argv[2] ?? process.env.CHROME_PATH;
if (!chromePath) throw new Error('Pass the Chrome executable path as the first argument or CHROME_PATH.');
const waitMs = 10_000;

let arrivals = []; // [response, arrival time] for the current trial
let released = false;
const release = () => {
  released = true;
  for (const [response] of arrivals) if (!response.writableEnded) response.end('<title>released</title>released');
};
const fixture = createServer((req, res) => {
  if (!req.url.startsWith('/barrier')) return res.end('<title>baseline</title>');
  if (released) return res.end('<title>late</title>late'); // a call that only started after the trial gave up
  arrivals.push([res, Date.now()]);
  if (arrivals.length === 2) release();
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${fixture.address().port}/`;
const worker = await createUpstreamFactory({
  chromePath, noSandbox: process.env.CHROME_NO_SANDBOX === '1', upstreamArgs: ['--page-id-routing'],
})({});
const text = result => result.content.find(block => block.type === 'text').text;
const options = { timeoutMs: waitMs * 3 };
const calls = {
  evaluate_script: pageId => worker.callTool('evaluate_script', { pageId, function: 'async () => await (await fetch("/barrier")).text()' }, options),
  navigate_page: pageId => worker.callTool('navigate_page', { pageId, type: 'url', url: `${url}barrier?${pageId}`, timeout: waitMs * 2 }, options),
};

/** Starts tool A on page 1 and tool B on page 2 together; reports whether both reached the barrier within waitMs. */
async function trial(toolA, toolB, [pageA, pageB]) {
  arrivals = [];
  released = false;
  const started = Date.now();
  const pending = [calls[toolA](pageA), calls[toolB](pageB)];
  while (arrivals.length < 2 && Date.now() - started < waitMs) await new Promise(resolve => setTimeout(resolve, 20));
  const overlapped = arrivals.length === 2;
  const gapMs = overlapped ? arrivals[1][1] - arrivals[0][1] : undefined;
  release();
  await Promise.allSettled(pending);
  return { calls: `${toolA} + ${toolB}`, overlapped, ...(overlapped ? { gapMs } : { secondNotStartedAfterMs: waitMs }) };
}

try {
  const pageIds = [];
  for (const isolatedContext of ['agent-a', 'agent-b']) {
    const pages = text(await worker.callTool('new_page', { url, isolatedContext }));
    pageIds.push(Number(pages.split('\n').find(line => /^\d+:.*\[selected\]/u.test(line)).match(/^(\d+)/u)[1]));
  }
  const evaluate = (pageId, fn) => worker.callTool('evaluate_script', { pageId, function: fn });
  await evaluate(pageIds[0], '() => { document.cookie = "agent=a; path=/"; return true; }');
  const cookieSeenByB = text(await evaluate(pageIds[1], '() => document.cookie')).includes('agent=a');
  // isolatedContext separates storage, not access: upstream has no caller identity, so any caller (agent B) lists
  // every context's pages with title and URL and can run scripts on agent A's page by its pageId.
  const listed = text(await worker.callTool('list_pages', {}));
  const listPagesShowsBothContexts = ['agent-a', 'agent-b'].every(context => listed.includes(`isolatedContext=${context}`));
  const cookieOfAReadByPageId = text(await evaluate(pageIds[0], '() => document.cookie')).includes('agent=a');
  const trials = [];
  for (const [toolA, toolB] of [['evaluate_script', 'evaluate_script'], ['navigate_page', 'navigate_page'], ['evaluate_script', 'navigate_page']]) {
    trials.push(await trial(toolA, toolB, pageIds));
  }
  process.stdout.write(`${JSON.stringify({ cookieSeenByB, listPagesShowsBothContexts, cookieOfAReadByPageId, trials }, null, 2)}\n`);
} finally {
  await worker.close();
  fixture.closeAllConnections();
  fixture.close();
}
