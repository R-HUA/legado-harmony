// Run deliberately: this submits paid Dreamina image jobs. Existing jobs are never resubmitted.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const output = resolve('output/membership-icons');
mkdirSync(output, { recursive: true });
const stateFile = resolve(output, 'jobs.json');
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { items: [] };
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|WS_PROXY|WSS_PROXY)$/i.test(key)) delete env[key];
}
const sets = [
  { key: 'A', name: '轻页书叶', style: 'Refined contemporary editorial icon, sculpted folded-book pages shaped as a leaf, soft satin enamel with restrained metallic edging, compact rounded silhouette, minimal premium reading-app design.',
    forms: ['a single folded mint jade leaf-page with silver edge', 'two layered lavender and violet leaf-pages with a small four-point star', 'a champagne gold folded book-leaf forming a clearly visible infinity loop', 'a dark emerald open book with two symmetrical broad gold leaf wings and a tiny central diamond'] },
  { key: 'B', name: '克制宝石', style: 'Precise luxury faceted gemstone badge, restrained luminous crystal and brushed metal, simple wide geometric silhouette, premium miniature collectible emblem, fewer large facets, front-facing.',
    forms: ['a single ice-blue diamond crystal in a slim silver open-book cradle', 'an amethyst diamond crystal with two small symmetric facets in a violet open-book cradle', 'a rose-gold diamond with a bold smooth infinity-loop gold setting below', 'a large deep midnight sapphire diamond, broad champagne-gold crown with three low points, dark gold open-book base'] },
  { key: 'C', name: '星轨羽翼', style: 'Dreamy but sophisticated celestial reading badge, a clean folded-page silhouette integrated with one broad orbital arc, smooth pearlescent glass and metallic edges, bold legible curves, front-facing.',
    forms: ['an aqua folded page and one clear four-point silver star with a short crescent orbit', 'a violet folded open-book page with one four-point star and a complete lavender orbit', 'a warm gold four-point star above an open book, a single thick infinity orbit framing it', 'a midnight-blue four-point star above a dark open book, two broad symmetrical gold feather wings and a restrained golden orbital arc'] }
];
const tiers = ['月度会员', '年度会员', '终身会员', '终身超级会员'];
const specs = sets.flatMap(set => set.forms.map((form, i) => ({
  key: `${set.key}${i + 1}`, set: set.name, tier: tiers[i],
  prompt: `Create ONE isolated app membership badge icon. ${set.style} Subject: ${form}. Square 1:1 composition, one centered object occupying about 68 percent of canvas, pure clean white background, subtle short ambient contact shadow only. Orthographic front view, broad crisp edges, tasteful soft studio light. Must remain distinguishable at 24px and 32px. No text, no letters, no numbers, no watermark, no panels, no app UI, no border, no repeated objects, no grid, no floating glitter. Production-quality coherent emblem, not a realistic scene.`
})));
writeFileSync(resolve(output, 'prompts.json'), JSON.stringify(specs, null, 2));
const mode = process.argv[2] || 'plan';
if (mode === 'submit') {
  for (const spec of specs) {
    if (state.items.some(item => item.key === spec.key)) continue;
    // Persist intent before the external side effect. An ambiguous failure requires manual recovery.
    const item = { ...spec, status: 'submitting' };
    state.items.push(item);
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
    try {
      const raw = execFileSync('dreamina.exe', ['text2image', '--prompt', spec.prompt,
        '--ratio=1:1', '--resolution_type=2k', '--generate_num=1', '--poll=0'],
        { env, encoding: 'utf8', timeout: 90000, windowsHide: true });
      const result = JSON.parse(raw);
      item.submitId = result.submit_id;
      item.status = result.gen_status || 'submitted';
      if (!item.submitId) throw new Error('No submit_id returned; inspect CLI task history before retrying');
      writeFileSync(stateFile, JSON.stringify(state, null, 2));
      console.log(JSON.stringify({ key: item.key, submitId: item.submitId, status: item.status }));
    } catch (error) {
      item.status = 'needs-recovery';
      writeFileSync(stateFile, JSON.stringify(state, null, 2));
      throw error;
    }
  }
} else if (mode === 'query') {
  for (const item of state.items) {
    if (!item.submitId || item.status === 'downloaded') continue;
    const dir = resolve(output, item.key);
    mkdirSync(dir, { recursive: true });
    const result = JSON.parse(execFileSync('dreamina.exe', ['query_result', `--submit_id=${item.submitId}`,
      `--download_dir=${dir}`], { env, encoding: 'utf8', timeout: 90000, windowsHide: true }));
    item.status = result.gen_status;
    // Save only public task identity and local media; never persist signed URLs.
    if (result.gen_status === 'success') item.status = 'downloaded';
    if (result.fail_reason) item.failReason = result.fail_reason;
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
    console.log(JSON.stringify({ key: item.key, status: item.status, reason: item.failReason }));
  }
} else {
  console.log(JSON.stringify({ count: specs.length, output, instruction: 'submit consumes credits; query resumes existing jobs' }));
}
